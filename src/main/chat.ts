import { ipcMain, type WebContents } from 'electron'
import { spawn, type ChildProcess } from 'child_process'
import { readdir, stat, open } from 'fs/promises'
import { join } from 'path'
import { homedir } from 'os'
import { claudeFlexibleSettingsPath } from './permissions'
import { bridgeEnv } from './bridge-state'

// Corre Claude Code / OpenCode en modo headless (un proceso por turno) y
// normaliza su salida a eventos simples para la vista de chat.
//   claude:   claude -p <msg> --output-format stream-json --verbose [--resume id]
//   opencode: opencode run [--continue] <msg>

const running = new Map<string, ChildProcess>()

const shellQuote = (s: string): string => `'${s.replace(/'/g, `'\\''`)}'`

export interface ChatSendOpts {
  id: string
  agent: 'claude' | 'opencode'
  cwd: string
  message: string
  sessionId: string | null
  permissionMode: 'plan' | 'edits' | 'flexible' | 'full'
  /** Modelo a usar (alias de claude o provider/model de opencode); null = el por defecto. */
  model?: string | null
}

export interface ChatTurnResult {
  text: string
  error: string | null
  sessionId: string | null
}

function buildCommand(opts: ChatSendOpts): string {
  if (opts.agent === 'claude') {
    const flags = ['-p', shellQuote(opts.message), '--output-format', 'stream-json', '--verbose']
    if (opts.model) flags.push('--model', shellQuote(opts.model))
    if (opts.sessionId) flags.push('--resume', shellQuote(opts.sessionId))
    if (opts.permissionMode === 'full') flags.push('--dangerously-skip-permissions')
    else if (opts.permissionMode === 'plan') flags.push('--permission-mode', 'plan')
    else if (opts.permissionMode === 'flexible')
      flags.push('--settings', shellQuote(claudeFlexibleSettingsPath()))
    else flags.push('--permission-mode', 'acceptEdits')
    return `claude ${flags.join(' ')}`
  }
  const cont = opts.sessionId ? '--continue ' : ''
  const model = opts.model ? `--model ${shellQuote(opts.model)} ` : ''
  return `opencode run ${cont}${model}${shellQuote(opts.message)}`
}

// Lista de modelos por agente: claude usa sus alias; opencode los expone con
// `opencode models` (provider/model). Se cachea por arranque.
let opencodeModelsCache: string[] | null = null

export async function listChatModels(agent: 'claude' | 'opencode'): Promise<string[]> {
  if (agent === 'claude') return ['fable', 'opus', 'sonnet', 'haiku']
  if (opencodeModelsCache) return opencodeModelsCache
  return new Promise((resolve) => {
    const child =
      process.platform === 'win32'
        ? spawn('opencode models', { shell: true })
        : spawn(process.env.SHELL || '/bin/bash', ['-ilc', 'opencode models'])
    let out = ''
    const timer = setTimeout(() => {
      child.kill()
      resolve([])
    }, 20000)
    child.stdout?.on('data', (d: Buffer) => (out += d.toString()))
    child.on('close', () => {
      clearTimeout(timer)
      const models = stripAnsi(out)
        .split('\n')
        .map((l) => l.trim())
        .filter((l) => l.includes('/') && !l.includes(' '))
      if (models.length > 0) opencodeModelsCache = models
      resolve(models)
    })
    child.on('error', () => {
      clearTimeout(timer)
      resolve([])
    })
  })
}

type SendFn = (payload: unknown) => void

function handleClaudeEvent(ev: any, send: SendFn, markResult: () => void): void {
  if (ev.type === 'system' && ev.subtype === 'init') {
    send({ kind: 'init', sessionId: ev.session_id })
  } else if (ev.type === 'assistant' && Array.isArray(ev.message?.content)) {
    for (const block of ev.message.content) {
      if (block.type === 'text' && block.text?.trim()) {
        send({ kind: 'text', text: block.text })
      } else if (block.type === 'tool_use') {
        const input = block.input ?? {}
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
    const meta =
      ev.total_cost_usd != null
        ? `$${Number(ev.total_cost_usd).toFixed(4)} · ${Math.round((ev.duration_ms ?? 0) / 1000)}s`
        : null
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
    const env = {
      ...process.env,
      ...bridgeEnv(),
      BRIDGE_CELL_ID: opts.id,
      TERM: 'dumb'
    } as Record<string, string>
    // -ilc (login + interactivo): garantiza el PATH del usuario aunque la app
    // se lance desde el menú de aplicaciones (nvm y similares viven en .bashrc,
    // que los shells no interactivos se saltan).
    const child =
      process.platform === 'win32'
        ? spawn(cmd, { cwd: opts.cwd, shell: true, env })
        : spawn(process.env.SHELL || '/bin/bash', ['-ilc', cmd], { cwd: opts.cwd, env })
    running.set(opts.id, child)

    let buf = ''
    let stderrTail = ''
    let gotResult = false

    child.stdout.on('data', (d: Buffer) => {
      if (opts.agent === 'opencode') {
        send({ kind: 'chunk', text: stripAnsi(d.toString()) })
        return
      }
      buf += d.toString()
      let nl: number
      while ((nl = buf.indexOf('\n')) >= 0) {
        const line = buf.slice(0, nl).trim()
        buf = buf.slice(nl + 1)
        if (!line) continue
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

    child.on('close', (code) => {
      running.delete(opts.id)
      if (opts.agent === 'opencode') {
        send({
          kind: 'done',
          sessionId: 'continue',
          meta: null,
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
  ipcMain.handle('chat:send', (event, opts: ChatSendOpts) => {
    const wc: WebContents = event.sender
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
