import { app, ipcMain, type WebContents } from 'electron'
import { spawn, type ChildProcess } from 'child_process'
import { readFileSync, writeFileSync } from 'fs'
import { readdir, readFile, stat, open } from 'fs/promises'
import { join } from 'path'
import { homedir } from 'os'
import { claudeFlexibleSettingsPath } from './permissions'
import { bridgeEnv, recordActivity } from './bridge-state'
import { autoCheckpoint } from './checkpoints'
import { claimSession, isSessionClaimed } from './pty'

// Corre Claude Code / OpenCode en modo headless (un proceso por turno) y
// normaliza su salida a eventos simples para la vista de chat.
//   claude:   claude -p <msg> --output-format stream-json --verbose [--resume id]
//   opencode: opencode run [--continue] <msg>

const running = new Map<string, ChildProcess>()

const shellQuote = (s: string): string => `'${s.replace(/'/g, `'\\''`)}'`

export interface ChatSendOpts {
  id: string
  agent: 'claude' | 'opencode' | 'antigravity'
  cwd: string
  message: string
  sessionId: string | null
  permissionMode: 'plan' | 'edits' | 'flexible' | 'full'
  /** Modelo a usar (alias de claude o provider/model de opencode); null = el por defecto. */
  model?: string | null
  /** Nivel de razonamiento (claude --effort / opencode --variant); null = auto. */
  effort?: string | null
}

export interface ChatTurnResult {
  text: string
  error: string | null
  sessionId: string | null
}

// Reglas del entorno headless por turnos: sin esto los agentes lanzan
// subagentes/tareas "en segundo plano" y cierran el turno esperándolas —
// pero el proceso muere al terminar el turno y quedan esperando para siempre.
const HEADLESS_NOTE =
  'Corres como chat headless por turnos dentro de BridgeEditor: el proceso ' +
  'termina cuando termina tu turno. NUNCA dejes tareas, subagentes ni comandos ' +
  'en segundo plano "para después" (morirán al cerrar el turno). Ejecuta todo ' +
  'en primer plano, espera los resultados de tus subagentes DENTRO del turno y ' +
  'entrega la respuesta completa antes de terminar. Además NO hay TTY ni stdin: ' +
  'los comandos que hacen preguntas interactivas (y/N, selectores) toman su ' +
  'default y suelen abortar — usa siempre banderas no interactivas (--yes, -y, ' +
  '--force, --non-interactive) y verifica precondiciones antes (p. ej. git ' +
  'status limpio antes de codemods).'

function buildCommand(opts: ChatSendOpts): string {
  if (opts.agent === 'antigravity') {
    // agy -p: print no-interactivo. No hay salida JSON: el texto plano se
    // procesa en el close (la salida reimprime el historial; ver agyTranscripts).
    const flags = ['-p', shellQuote(opts.message), '--print-timeout', '15m']
    if (opts.model) flags.push('--model', shellQuote(opts.model))
    if (opts.sessionId) flags.push('--conversation', shellQuote(opts.sessionId))
    if (opts.permissionMode === 'full') flags.push('--dangerously-skip-permissions')
    return `agy ${flags.join(' ')}`
  }
  if (opts.agent === 'claude') {
    const flags = ['-p', shellQuote(opts.message), '--output-format', 'stream-json', '--verbose']
    flags.push('--append-system-prompt', shellQuote(HEADLESS_NOTE))
    if (opts.model) flags.push('--model', shellQuote(opts.model))
    if (opts.effort) flags.push('--effort', shellQuote(opts.effort))
    if (opts.sessionId) flags.push('--resume', shellQuote(opts.sessionId))
    if (opts.permissionMode === 'full') flags.push('--dangerously-skip-permissions')
    else if (opts.permissionMode === 'plan') flags.push('--permission-mode', 'plan')
    else if (opts.permissionMode === 'flexible')
      flags.push('--settings', shellQuote(claudeFlexibleSettingsPath()))
    else flags.push('--permission-mode', 'acceptEdits')
    return `claude ${flags.join(' ')}`
  }
  // 'continue' es el marcador legado (antes de rastrear el sessionID real)
  const session = opts.sessionId
    ? opts.sessionId === 'continue'
      ? '--continue '
      : `--session ${shellQuote(opts.sessionId)} `
    : ''
  const model = opts.model ? `--model ${shellQuote(opts.model)} ` : ''
  const variant = opts.effort ? `--variant ${shellQuote(opts.effort)} ` : ''
  // --thinking: sin él opencode omite los eventos "reasoning" del stream
  return `opencode run --format json --thinking ${session}${model}${variant}${shellQuote(opts.message)}`
}

const fmtTokens = (n: number): string => (n >= 1000 ? `${(n / 1000).toFixed(1)}k` : String(n))

/** Acumulado de un turno de opencode (eventos --format json). */
interface OpencodeTurnState {
  session: string | null
  cost: number
  tokensIn: number
  tokensOut: number
  sentTools: Set<string>
}

function handleOpencodeEvent(ev: any, state: OpencodeTurnState, send: SendFn): void {
  if (typeof ev.sessionID === 'string') state.session = ev.sessionID
  const part = ev.part ?? {}
  if (ev.type === 'text' && typeof part.text === 'string' && part.text.trim()) {
    send({ kind: 'text', text: part.text })
  } else if (ev.type === 'reasoning' && typeof part.text === 'string' && part.text.trim()) {
    send({ kind: 'thinking', text: part.text })
  } else if (ev.type === 'tool') {
    if (part.state?.status && part.state.status !== 'completed') return
    const id = String(part.id ?? Math.random())
    if (state.sentTools.has(id)) return
    state.sentTools.add(id)
    const input = part.state?.input ?? {}
    const detail =
      input.command ?? input.filePath ?? input.path ?? input.pattern ?? input.url ?? ''
    send({ kind: 'tool', name: String(part.tool ?? 'tool'), detail: String(detail).slice(0, 140) })
  } else if (ev.type === 'step_finish') {
    if (typeof part.cost === 'number') state.cost += part.cost
    const tokens = part.tokens
    if (tokens) {
      state.tokensIn =
        (tokens.input ?? 0) + (tokens.cache?.read ?? 0) + (tokens.cache?.write ?? 0)
      state.tokensOut += tokens.output ?? 0
    }
  }
}

// Lista de modelos por agente: claude usa sus alias; opencode y antigravity
// los exponen con su subcomando `models`. Se cachea por arranque.
const modelsCache = new Map<string, string[]>()

function runModelsCommand(cmd: string, parse: (out: string) => string[]): Promise<string[]> {
  if (modelsCache.has(cmd)) return Promise.resolve(modelsCache.get(cmd)!)
  return new Promise((resolve) => {
    const child =
      process.platform === 'win32'
        ? spawn(cmd, { shell: true, stdio: ['ignore', 'pipe', 'pipe'] })
        : spawn(process.env.SHELL || '/bin/bash', ['-ilc', cmd], {
            stdio: ['ignore', 'pipe', 'pipe']
          })
    let out = ''
    const timer = setTimeout(() => {
      child.kill()
      resolve([])
    }, 20000)
    child.stdout?.on('data', (d: Buffer) => (out += d.toString()))
    child.on('close', () => {
      clearTimeout(timer)
      const models = parse(stripAnsi(out))
      if (models.length > 0) modelsCache.set(cmd, models)
      resolve(models)
    })
    child.on('error', () => {
      clearTimeout(timer)
      resolve([])
    })
  })
}

export async function listChatModels(
  agent: 'claude' | 'opencode' | 'antigravity'
): Promise<string[]> {
  if (agent === 'claude') return ['fable', 'opus', 'sonnet', 'haiku']
  if (agent === 'antigravity') {
    // nombres con espacios y "(Effort)" — el effort va dentro del modelo
    return runModelsCommand('agy models', (out) =>
      out
        .split('\n')
        .map((l) => l.trim())
        .filter((l) => l.length > 0 && !l.startsWith('Usage') && !l.startsWith('-'))
    )
  }
  return runModelsCommand('opencode models', (out) =>
    out
      .split('\n')
      .map((l) => l.trim())
      .filter((l) => l.includes('/') && !l.includes(' '))
  )
}

type SendFn = (payload: unknown) => void

function handleClaudeEvent(ev: any, send: SendFn, markResult: () => void): void {
  if (ev.type === 'system' && ev.subtype === 'init') {
    send({ kind: 'init', sessionId: ev.session_id })
  } else if (ev.type === 'assistant' && Array.isArray(ev.message?.content)) {
    for (const block of ev.message.content) {
      if (block.type === 'text' && block.text?.trim()) {
        send({ kind: 'text', text: block.text })
      } else if (block.type === 'thinking' && typeof block.thinking === 'string' && block.thinking.trim()) {
        send({ kind: 'thinking', text: block.thinking })
      } else if (block.type === 'tool_use') {
        const input = block.input ?? {}
        // Subagentes (Task): chip propio para que se vea quién está trabajando.
        if (block.name === 'Task') {
          const kind = typeof input.subagent_type === 'string' ? ` (${input.subagent_type})` : ''
          const what = input.description ?? (typeof input.prompt === 'string' ? input.prompt.slice(0, 100) : '')
          send({ kind: 'tool', name: `Subagente${kind}`, detail: String(what).slice(0, 140) })
          continue
        }
        const detail =
          input.command ??
          input.file_path ??
          input.path ??
          input.pattern ??
          input.url ??
          input.description ??
          (typeof input.prompt === 'string' ? input.prompt.slice(0, 80) : '')
        send({ kind: 'tool', name: block.name, detail: String(detail).slice(0, 140) })
      }
    }
  } else if (ev.type === 'result') {
    markResult()
    const parts: string[] = []
    if (ev.total_cost_usd != null) parts.push(`$${Number(ev.total_cost_usd).toFixed(4)}`)
    if (ev.duration_ms != null) parts.push(`${Math.round(ev.duration_ms / 1000)}s`)
    const usage = ev.usage
    if (usage) {
      const inputTokens =
        (usage.input_tokens ?? 0) +
        (usage.cache_read_input_tokens ?? 0) +
        (usage.cache_creation_input_tokens ?? 0)
      parts.push(`↑${fmtTokens(inputTokens)} ↓${fmtTokens(usage.output_tokens ?? 0)} tok`)
    }
    const meta = parts.length > 0 ? parts.join(' · ') : null
    send({
      kind: 'done',
      sessionId: ev.session_id ?? null,
      meta,
      error: ev.is_error ? String(ev.result ?? 'el turno terminó con error') : null
    })
  }
}

const stripAnsi = (s: string): string =>
  // eslint-disable-next-line no-control-regex
  s.replace(/\x1b\[[0-9;?]*[a-zA-Z]/g, '')

// --- Antigravity (agy) ---
// Su modo print reimprime TODO el historial de la conversación y agrega la
// respuesta nueva al final. Guardamos la salida acumulada por conversación
// (persistida en userData para que el resume sobreviva reinicios) y la
// respuesta del turno es el sufijo que aparece después del prefijo conocido.
const AGY_TRANSCRIPTS_LIMIT = 40
let agyTranscriptsLoaded: Map<string, string> | null = null

const agyTranscriptsPath = (): string => join(app.getPath('userData'), 'agy-transcripts.json')

function agyTranscripts(): Map<string, string> {
  if (agyTranscriptsLoaded) return agyTranscriptsLoaded
  try {
    const raw = JSON.parse(readFileSync(agyTranscriptsPath(), 'utf8')) as Record<string, string>
    agyTranscriptsLoaded = new Map(Object.entries(raw))
  } catch {
    agyTranscriptsLoaded = new Map()
  }
  return agyTranscriptsLoaded
}

function rememberAgyTranscript(convId: string, full: string): void {
  const m = agyTranscripts()
  m.delete(convId) // re-insertar refresca el orden (Map conserva orden de inserción)
  m.set(convId, full)
  while (m.size > AGY_TRANSCRIPTS_LIMIT) m.delete(m.keys().next().value as string)
  try {
    writeFileSync(agyTranscriptsPath(), JSON.stringify(Object.fromEntries(m)))
  } catch {
    // sin disco no hay persistencia, pero el turno sigue funcionando
  }
}

const AGY_CONV_DIR = join(homedir(), '.gemini', 'antigravity-cli', 'conversations')
const AGY_LOG_DIR = join(homedir(), '.gemini', 'antigravity-cli', 'log')

// agy -p tiene un defecto serio: ante errores del backend (cuota agotada,
// auth vencida…) sale con código 0 y stdout vacío. El error real solo queda
// en su log: lo rescatamos para mostrárselo al usuario en el chat.
async function lastAgyError(sinceMs: number): Promise<string | null> {
  try {
    const names = await readdir(AGY_LOG_DIR)
    let best: { name: string; mtime: number } | null = null
    for (const name of names) {
      const st = await stat(join(AGY_LOG_DIR, name)).catch(() => null)
      if (!st || st.mtimeMs < sinceMs - 2000) continue
      if (!best || st.mtimeMs > best.mtime) best = { name, mtime: st.mtimeMs }
    }
    if (!best) return null
    const content = await readFile(join(AGY_LOG_DIR, best.name), 'utf8')
    const errLines = content
      .split('\n')
      .filter((l) => /agent executor error|RESOURCE_EXHAUSTED|PERMISSION_DENIED|UNAUTHENTICATED|not logged in/i.test(l))
    const last = errLines[errLines.length - 1]
    if (!last) return null
    // quitar el prefijo glog (E0610 16:08:01.883799 25381 log.go:398])
    return last.replace(/^[EWIF]\d{4} [\d:.]+\s+\d+ [^\]]+\]\s*/, '').slice(0, 300)
  } catch {
    return null
  }
}

// El id de una conversación nueva es el nombre del archivo .db/.pb más
// reciente en el directorio de conversaciones (mismo truco que el rastreo
// de sesiones de claude por celda). Se saltan las reclamadas por celdas TUI.
async function latestAgyConversation(sinceMs: number): Promise<string | null> {
  try {
    const names = await readdir(AGY_CONV_DIR)
    let best: { id: string; mtime: number } | null = null
    for (const name of names) {
      const m = name.match(/^(.+)\.(db|pb)$/)
      if (!m || isSessionClaimed(m[1])) continue
      const st = await stat(join(AGY_CONV_DIR, name)).catch(() => null)
      if (!st || st.mtimeMs < sinceMs - 2000) continue
      if (!best || st.mtimeMs > best.mtime) best = { id: m[1], mtime: st.mtimeMs }
    }
    return best?.id ?? null
  } catch {
    return null
  }
}

/**
 * Ejecuta un turno headless y emite los eventos normalizados por `emit`.
 * Lo usan el chat de cada celda (IPC) y el puente de delegación entre celdas,
 * que además necesita el texto final acumulado para devolverlo al orquestador.
 */
export function executeChatTurn(opts: ChatSendOpts, emit: SendFn): Promise<ChatTurnResult> {
  return new Promise<ChatTurnResult>((resolveTurn) => {
    const collected: string[] = []
    let finalError: string | null = null
    let finalSession: string | null = null

    const send: SendFn = (payload) => {
      const ev = payload as {
        kind?: string
        text?: string
        sessionId?: string
        error?: string
        message?: string
      }
      if (ev.kind === 'text' && ev.text) collected.push(ev.text)
      else if (ev.kind === 'chunk' && ev.text) {
        if (collected.length === 0) collected.push('')
        collected[collected.length - 1] += ev.text
      } else if (ev.kind === 'init' && ev.sessionId) finalSession = ev.sessionId
      else if (ev.kind === 'done') {
        finalSession = ev.sessionId ?? finalSession
        finalError = ev.error ?? null
      } else if (ev.kind === 'error') finalError = ev.message ?? 'error'
      emit(payload)
    }

    const cmd = buildCommand(opts)
    // que el rastreador de celdas TUI no reclame la conversación de este chat
    // (su archivo .db recibe mtime nuevo con cada turno)
    if (opts.agent === 'antigravity' && opts.sessionId) claimSession(opts.sessionId)
    const env = {
      ...process.env,
      ...bridgeEnv(),
      BRIDGE_CELL_ID: opts.id,
      TERM: 'dumb'
    } as Record<string, string>
    // -ilc (login + interactivo): garantiza el PATH del usuario aunque la app
    // se lance desde el menú de aplicaciones (nvm y similares viven en .bashrc,
    // que los shells no interactivos se saltan).
    // stdio: stdin cerrado — opencode run lee stdin si está abierto (modo pipe)
    // y se quedaría esperando EOF para siempre.
    const stdio: ['ignore', 'pipe', 'pipe'] = ['ignore', 'pipe', 'pipe']
    const child =
      process.platform === 'win32'
        ? spawn(cmd, { cwd: opts.cwd, shell: true, env, stdio })
        : spawn(process.env.SHELL || '/bin/bash', ['-ilc', cmd], { cwd: opts.cwd, env, stdio })
    running.set(opts.id, child)

    let buf = ''
    let stderrTail = ''
    let gotResult = false
    const startTime = Date.now()
    const ocState: OpencodeTurnState = {
      session: null,
      cost: 0,
      tokensIn: 0,
      tokensOut: 0,
      sentTools: new Set()
    }

    let agyOut = ''
    child.stdout.on('data', (d: Buffer) => {
      if (opts.agent === 'antigravity') {
        // texto plano acumulativo: se procesa completo en el close
        agyOut += d.toString()
        return
      }
      buf += d.toString()
      let nl: number
      while ((nl = buf.indexOf('\n')) >= 0) {
        const line = buf.slice(0, nl).trim()
        buf = buf.slice(nl + 1)
        if (!line) continue
        if (opts.agent === 'opencode') {
          try {
            handleOpencodeEvent(JSON.parse(line), ocState, send)
          } catch {
            // versión vieja de opencode sin --format json: degradar a texto plano
            const clean = stripAnsi(line)
            if (clean.trim()) send({ kind: 'chunk', text: clean + '\n' })
          }
          continue
        }
        try {
          handleClaudeEvent(JSON.parse(line), send, () => {
            gotResult = true
          })
        } catch {
          // línea que no es JSON (banners, warnings): ignorar
        }
      }
    })

    child.stderr.on('data', (d: Buffer) => {
      // ruido esperable del shell -i sin TTY
      const clean = d
        .toString()
        .split('\n')
        .filter((l) => !l.includes('job control') && !l.includes('process group'))
        .join('\n')
      stderrTail = (stderrTail + clean).slice(-2000)
    })

    child.on('close', async (code) => {
      running.delete(opts.id)
      if (opts.agent === 'antigravity') {
        const full = stripAnsi(agyOut).trim()
        // conversación: la conocida, o la recién creada por este turno
        const convId = opts.sessionId ?? (await latestAgyConversation(startTime))
        if (convId) claimSession(convId) // que el rastreador TUI no la reclame
        const prev = opts.sessionId ? (agyTranscripts().get(opts.sessionId) ?? '') : ''
        let text = full
        if (prev && full.startsWith(prev)) text = full.slice(prev.length).trim()
        if (convId) rememberAgyTranscript(convId, full)
        if (text) send({ kind: 'text', text })
        let error: string | null = code
          ? stripAnsi(stderrTail) || `agy terminó con código ${code}`
          : null
        if (!error && !text) {
          // agy "exitoso" pero mudo: rescatar el error real de su log
          error =
            (await lastAgyError(startTime)) ??
            'agy no devolvió respuesta (sin error reportado; revisa ~/.gemini/antigravity-cli/log)'
        }
        send({
          kind: 'done',
          sessionId: convId,
          meta: `${Math.round((Date.now() - startTime) / 1000)}s`,
          error
        })
        resolveTurn({ text: collected.join('\n\n').trim(), error: finalError, sessionId: finalSession })
        return
      }
      if (opts.agent === 'opencode') {
        const metaParts: string[] = []
        if (ocState.cost > 0) metaParts.push(`$${ocState.cost.toFixed(4)}`)
        metaParts.push(`${Math.round((Date.now() - startTime) / 1000)}s`)
        if (ocState.tokensIn > 0 || ocState.tokensOut > 0) {
          metaParts.push(`↑${fmtTokens(ocState.tokensIn)} ↓${fmtTokens(ocState.tokensOut)} tok`)
        }
        send({
          kind: 'done',
          sessionId: ocState.session ?? 'continue',
          meta: metaParts.join(' · '),
          error: code ? stderrTail || `código ${code}` : null
        })
      } else if (!gotResult) {
        send({
          kind: 'error',
          message: `claude terminó sin resultado (código ${code}). ${stripAnsi(stderrTail) || '¿Está instalado y autenticado?'}`
        })
        if (!finalError) finalError = `claude terminó sin resultado (código ${code})`
      }
      resolveTurn({ text: collected.join('\n\n').trim(), error: finalError, sessionId: finalSession })
    })

    child.on('error', (err) => {
      running.delete(opts.id)
      send({ kind: 'error', message: String(err) })
      resolveTurn({ text: '', error: String(err), sessionId: null })
    })
  })
}

export function registerChatHandlers(): void {
  ipcMain.handle('chat:send', async (event, opts: ChatSendOpts) => {
    const wc: WebContents = event.sender
    recordActivity({
      cellId: opts.id,
      kind: 'chat-turn',
      detail: opts.message.replace(/\s+/g, ' ').slice(0, 120)
    })
    // snapshot del workspace antes de un turno que puede editar archivos
    if (opts.permissionMode !== 'plan') {
      await autoCheckpoint(opts.cwd, `antes de turno de ${opts.agent}`)
    }
    return executeChatTurn(opts, (payload) => {
      if (!wc.isDestroyed()) wc.send(`chat:event:${opts.id}`, payload)
    }).then(() => undefined)
  })

  ipcMain.handle('chat:models', (_event, agent: 'claude' | 'opencode') => listChatModels(agent))

  // Lista las sesiones guardadas de Claude Code para un proyecto, leyendo los
  // .jsonl de ~/.claude/projects/<ruta-codificada>/. Soporta el /resume del chat.
  ipcMain.handle('chat:sessions', async (_event, cwd: string) => {
    const encoded = cwd.replace(/[^a-zA-Z0-9]/g, '-')
    const dir = join(homedir(), '.claude', 'projects', encoded)
    let names: string[]
    try {
      names = await readdir(dir)
    } catch {
      return []
    }
    const stats = await Promise.all(
      names
        .filter((n) => n.endsWith('.jsonl'))
        .map(async (n) => {
          const info = await stat(join(dir, n)).catch(() => null)
          return info ? { id: n.slice(0, -6), file: join(dir, n), mtimeMs: info.mtimeMs } : null
        })
    )
    const sessions = stats
      .filter((s): s is NonNullable<typeof s> => s !== null)
      .sort((a, b) => b.mtimeMs - a.mtimeMs)
      .slice(0, 20)

    return Promise.all(
      sessions.map(async (s) => {
        let summary = ''
        try {
          const fh = await open(s.file, 'r')
          const buf = Buffer.alloc(32768)
          const { bytesRead } = await fh.read(buf, 0, buf.length, 0)
          await fh.close()
          for (const line of buf.subarray(0, bytesRead).toString('utf8').split('\n')) {
            try {
              const obj = JSON.parse(line)
              if (obj.type === 'summary' && typeof obj.summary === 'string') {
                summary = obj.summary
                break
              }
              if (obj.type === 'user' && obj.message) {
                const content = obj.message.content
                const text =
                  typeof content === 'string'
                    ? content
                    : Array.isArray(content)
                      ? (content.find((b: { type: string }) => b.type === 'text')?.text ?? '')
                      : ''
                const cleanText = String(text).trim()
                // los mensajes que empiezan con '<' son internos del harness
                if (cleanText && !cleanText.startsWith('<')) {
                  summary = cleanText.replace(/\s+/g, ' ').slice(0, 90)
                  break
                }
              }
            } catch {
              // línea truncada o no JSON
            }
          }
        } catch {
          // sin resumen
        }
        return { id: s.id, mtimeMs: s.mtimeMs, summary }
      })
    )
  })

  ipcMain.on('chat:cancel', (_event, { id }: { id: string }) => {
    const child = running.get(id)
    if (child) {
      running.delete(id)
      try {
        child.kill('SIGTERM')
      } catch {
        // ya murió
      }
    }
  })
}

export function killAllChats(): void {
  for (const child of running.values()) {
    try {
      child.kill('SIGTERM')
    } catch {
      // ignorar
    }
  }
  running.clear()
}
