import { useEffect, useRef, useState } from 'react'
import { renderMarkdown } from './highlight'
import { CELL_MIME, pathsFromDrop, quotePaths } from './dnd'
import { titleFromPrompt } from './titles'
import { Palette } from './Palette'
import type { AgentKind } from './App'

interface ChatMsg {
  role:
    | 'user'
    | 'remote-user'
    | 'assistant'
    | 'thinking'
    | 'tool'
    | 'meta'
    | 'error'
    | 'proposal'
    | 'permission'
  text: string
  name?: string
  /** Para 'proposal': celda destino del @delegate. */
  target?: string
  /** Para 'proposal': pending | sent | dismissed */
  state?: 'pending' | 'sent' | 'dismissed'
  /** Para 'permission': id de la solicitud y directorios externos pedidos. */
  requestId?: string
  dirs?: string[]
  /** Para 'permission': decisión tomada (undefined = aún pendiente). */
  decision?: 'once' | 'all' | 'reject'
}

/** @delegate(2, "tarea") emitido por el agente en su respuesta. */
const DELEGATE_RE = /@delegate\(\s*([\w-]+)\s*,\s*"([^"]{3,500})"\s*\)/g

type ChatPerm = 'plan' | 'edits' | 'flexible' | 'full'

interface ChatViewProps {
  cellId: string
  agent: Exclude<AgentKind, 'shell'>
  cwd: string
  active: boolean
  initialPerm: ChatPerm
  sessionId: string | null
  model: string | null
  effort: string | null
  /** La celda ya tiene título: los mensajes entrantes no lo pisan. */
  titled: boolean
  /** Título deducido del primer mensaje de la conversación. */
  onAutoTitle: (title: string) => void
  onModel: (model: string | null) => void
  onEffort: (effort: string | null) => void
  onSessionId: (id: string | null) => void
  onActivity: (activity: 'working' | 'idle') => void
  onAttention: () => void
}

interface SessionInfo {
  id: string
  mtimeMs: number
  summary: string
}

const HELP_TEXT =
  '/resume — elegir una sesión anterior · /continue — retomar la más reciente · ' +
  '/new — conversación nueva · /compact — resumir el contexto y seguir en sesión ' +
  'nueva · /help — esta ayuda. Cualquier otro /comando se envía al agente (tus ' +
  'comandos personalizados de .claude/commands funcionan).'

const COMPACT_PROMPT =
  'Resume esta conversación de forma compacta para continuarla en una sesión nueva ' +
  'sin este historial: objetivo, decisiones tomadas, estado actual del trabajo ' +
  '(archivos tocados, pendientes) y datos concretos imprescindibles. Responde SOLO ' +
  'con el resumen.'

// Niveles de razonamiento por agente: claude --effort / opencode --variant.
// antigravity no tiene flag aparte: el effort va dentro del nombre del modelo.
const EFFORT_OPTIONS: Record<'claude' | 'opencode' | 'antigravity', string[]> = {
  claude: ['low', 'medium', 'high', 'xhigh', 'max'],
  opencode: ['minimal', 'low', 'medium', 'high', 'max'],
  antigravity: []
}

const PERM_LABELS: Record<ChatPerm, string> = {
  plan: 'solo planear',
  edits: 'acepta ediciones',
  flexible: 'flexible (solo crítico)',
  full: 'sin preguntar'
}

/** Ocupación del contexto de la conversación (ver el evento 'usage'). */
interface CtxUsage {
  tokens: number
  /** Tamaño de la ventana del modelo; null mientras no se conozca. */
  window: number | null
}

// El contexto se mide por sesión del agente, no por celda: así sobrevive a
// reinicios de la app y a mover la conversación de celda.
const ctxKey = (sessionId: string): string => `bridge-editor.ctx.${sessionId}`

function loadCtx(sessionId: string | null): CtxUsage | null {
  if (!sessionId) return null
  try {
    const raw = localStorage.getItem(ctxKey(sessionId))
    if (!raw) return null
    const saved = JSON.parse(raw) as CtxUsage
    return typeof saved?.tokens === 'number' ? saved : null
  } catch {
    return null
  }
}


const fmtCtx = (n: number): string =>
  n >= 1_000_000 ? `${(n / 1_000_000).toFixed(2)}M` : n >= 1000 ? `${Math.round(n / 1000)}k` : String(n)

export function ChatView({
  cellId,
  agent,
  cwd,
  active,
  initialPerm,
  sessionId,
  model,
  effort,
  titled,
  onAutoTitle,
  onModel,
  onEffort,
  onSessionId,
  onActivity,
  onAttention
}: ChatViewProps): JSX.Element {
  const [messages, setMessages] = useState<ChatMsg[]>(() =>
    sessionId ? [{ role: 'meta', text: 'continuando la sesión anterior' }] : []
  )
  const [input, setInput] = useState('')
  const [running, setRunning] = useState(false)
  const [elapsed, setElapsed] = useState(0)
  const [permMode, setPermMode] = useState<ChatPerm>(initialPerm)
  const [sessions, setSessions] = useState<SessionInfo[] | null>(null)
  const [models, setModels] = useState<string[]>([])
  const [ctx, setCtx] = useState<CtxUsage | null>(() => loadCtx(sessionId))
  // Permisos, modelo y effort viven en un panel plegable: en una grilla de 3+
  // celdas los selectores en línea dejaban el campo de texto sin ancho.
  const [optsOpen, setOptsOpen] = useState(false)
  const [modelPicker, setModelPicker] = useState(false)

  useEffect(() => {
    window.bridge.chatModels(agent).then(setModels)
  }, [agent])
  const listRef = useRef<HTMLDivElement>(null)
  const inputRef = useRef<HTMLTextAreaElement>(null)
  const bottomRef = useRef<HTMLDivElement>(null)
  const sessionRef = useRef(sessionId)
  const activeRef = useRef(active)
  activeRef.current = active
  const titledRef = useRef(titled)
  titledRef.current = titled
  // /compact: true mientras esperamos el resumen; el resumen listo se adjunta
  // como contexto al próximo mensaje del usuario en la sesión nueva.
  const compactingRef = useRef(false)
  const pendingContextRef = useRef<string | null>(null)
  const ctxRef = useRef<CtxUsage | null>(ctx)

  // Persistir la ocupación del contexto necesita el id de sesión, que en
  // opencode sólo se conoce al cerrar el turno: por eso se guarda también ahí.
  const rememberCtx = (usage: CtxUsage | null): void => {
    ctxRef.current = usage
    const id = sessionRef.current
    if (!id) return
    try {
      if (usage) localStorage.setItem(ctxKey(id), JSON.stringify(usage))
      else localStorage.removeItem(ctxKey(id))
    } catch {
      // sin localStorage el indicador sigue vivo en memoria
    }
  }

  useEffect(() => {
    const off = window.bridge.onChatEvent(cellId, (ev) => {
      switch (ev.kind) {
        case 'init':
          sessionRef.current = ev.sessionId
          onSessionId(ev.sessionId)
          break
        case 'remote-user': {
          setMessages((ms) => [...ms, { role: 'remote-user', text: ev.text, name: ev.from }])
          // Celda que recibe una delegación sin título propio: la tarea
          // delegada es lo que mejor la describe.
          if (!titledRef.current) {
            const t = titleFromPrompt(ev.text)
            if (t) onAutoTitle(t)
          }
          break
        }
        case 'turn-start':
          setRunning(true)
          onActivity('working')
          break
        case 'text': {
          setMessages((ms) => {
            const next: ChatMsg[] = [...ms, { role: 'assistant', text: ev.text }]
            // marcadores @delegate del agente → tarjetas de propuesta
            DELEGATE_RE.lastIndex = 0
            let m: RegExpExecArray | null
            while ((m = DELEGATE_RE.exec(ev.text))) {
              next.push({ role: 'proposal', target: m[1], text: m[2], state: 'pending' })
            }
            return next
          })
          break
        }
        case 'thinking':
          setMessages((ms) => [...ms, { role: 'thinking', text: ev.text }])
          break
        case 'chunk':
          setMessages((ms) => {
            const last = ms[ms.length - 1]
            if (last?.role === 'assistant') {
              return [...ms.slice(0, -1), { ...last, text: last.text + ev.text }]
            }
            return [...ms, { role: 'assistant', text: ev.text }]
          })
          break
        case 'tool':
          setMessages((ms) => [...ms, { role: 'tool', name: ev.name, text: ev.detail }])
          break
        case 'usage': {
          // Una ventana ya conocida no se pierde porque un turno la reporte sin
          // dato (pasa en el primer turno tras arrancar con un modelo nuevo).
          const usage: CtxUsage = {
            tokens: ev.contextTokens,
            window: ev.contextWindow ?? ctxRef.current?.window ?? null
          }
          setCtx(usage)
          rememberCtx(usage)
          break
        }
        case 'permission-request':
          setRunning(false)
          onActivity('idle')
          setMessages((ms) => [...ms, { role: 'permission', text: '', requestId: ev.requestId, dirs: ev.dirs }])
          if (!activeRef.current) onAttention()
          break
        case 'done':
          setRunning(false)
          onActivity('idle')
          if (ev.sessionId) {
            sessionRef.current = ev.sessionId
            onSessionId(ev.sessionId)
            rememberCtx(ctxRef.current)
          }
          if (ev.error) setMessages((ms) => [...ms, { role: 'error', text: ev.error! }])
          else if (ev.meta) setMessages((ms) => [...ms, { role: 'meta', text: ev.meta! }])
          if (compactingRef.current) {
            compactingRef.current = false
            if (!ev.error) {
              setMessages((ms) => {
                const summary = [...ms].reverse().find((m) => m.role === 'assistant')?.text
                pendingContextRef.current = summary ?? null
                return [
                  ...ms,
                  {
                    role: 'meta',
                    text: '🧹 contexto compactado — sesión nueva; el resumen de arriba se adjuntará a tu próximo mensaje'
                  }
                ]
              })
              sessionRef.current = null
              onSessionId(null)
              setCtx(null)
              ctxRef.current = null
            }
          }
          if (!activeRef.current) onAttention()
          break
        case 'error':
          setRunning(false)
          onActivity('idle')
          setMessages((ms) => [...ms, { role: 'error', text: ev.message }])
          if (!activeRef.current) onAttention()
          break
      }
    })
    return () => {
      off()
      window.bridge.chatCancel(cellId)
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [cellId])

  useEffect(() => {
    const el = listRef.current
    if (el) el.scrollTop = el.scrollHeight
  }, [messages, running])

  useEffect(() => {
    if (!running) return
    setElapsed(0)
    const t = window.setInterval(() => setElapsed((s) => s + 1), 1000)
    return () => window.clearInterval(t)
  }, [running])

  useEffect(() => {
    if (active && !running) inputRef.current?.focus()
  }, [active, running])

  // El panel de opciones se cierra al tocar fuera o con Escape.
  useEffect(() => {
    if (!optsOpen) return
    const onDown = (e: MouseEvent): void => {
      if (!bottomRef.current?.contains(e.target as Node)) setOptsOpen(false)
    }
    const onKey = (e: KeyboardEvent): void => {
      if (e.key === 'Escape') setOptsOpen(false)
    }
    document.addEventListener('mousedown', onDown)
    document.addEventListener('keydown', onKey)
    return () => {
      document.removeEventListener('mousedown', onDown)
      document.removeEventListener('keydown', onKey)
    }
  }, [optsOpen])

  // Ctrl+Shift+A/D desde App: insertar la ruta elegida en el mensaje.
  useEffect(() => {
    const onInsert = (e: Event): void => {
      const detail = (e as CustomEvent).detail as { cellId: string; text: string }
      if (detail.cellId !== cellId) return
      setInput((current) => (current ? `${current} ${detail.text}` : detail.text))
      inputRef.current?.focus()
    }
    window.addEventListener('bridge:insert-path', onInsert)
    return () => window.removeEventListener('bridge:insert-path', onInsert)
  }, [cellId])

  const addMeta = (text: string): void => setMessages((ms) => [...ms, { role: 'meta', text }])

  const pickSession = (s: SessionInfo): void => {
    sessionRef.current = s.id
    onSessionId(s.id)
    setSessions(null)
    const saved = loadCtx(s.id)
    setCtx(saved)
    ctxRef.current = saved
    setMessages([{ role: 'meta', text: `sesión retomada: ${s.summary || s.id.slice(0, 8)}` }])
  }

  const resetConversation = (): void => {
    sessionRef.current = null
    pendingContextRef.current = null
    onSessionId(null)
    setCtx(null)
    ctxRef.current = null
    setMessages([{ role: 'meta', text: 'conversación nueva' }])
  }

  // /resume, /continue, /new y /help se resuelven aquí (en headless no existen
  // los slash commands integrados del TUI); el resto viaja al agente.
  const handleSlash = (message: string): boolean => {
    const cmd = message.split(/\s+/)[0].toLowerCase()
    if (cmd === '/new' || cmd === '/clear') {
      resetConversation()
      return true
    }
    if (cmd === '/help') {
      addMeta(HELP_TEXT)
      return true
    }
    if (cmd === '/compact') {
      if (!sessionRef.current) {
        addMeta('no hay conversación que compactar — ya estás en sesión nueva')
        return true
      }
      compactingRef.current = true
      addMeta('🧹 compactando: pidiendo el resumen al agente…')
      sendText(COMPACT_PROMPT, null)
      return true
    }
    if (cmd === '/resume' || cmd === '/continue') {
      if (agent !== 'claude') {
        addMeta('solo disponible en chats de Claude Code')
        return true
      }
      window.bridge.chatSessions(cwd).then((list) => {
        if (list.length === 0) addMeta('no hay sesiones guardadas para este directorio')
        else if (cmd === '/continue') pickSession(list[0])
        else setSessions(list)
      })
      return true
    }
    return false
  }

  // Ejecutar una propuesta @delegate: delegar y devolver el resultado al
  // orquestador como un turno nuevo automático.
  const runProposal = async (index: number): Promise<void> => {
    const proposal = messages[index]
    if (!proposal || proposal.role !== 'proposal' || proposal.state !== 'pending') return
    setMessages((ms) => ms.map((m, i) => (i === index ? { ...m, state: 'sent' as const } : m)))
    addMeta(`delegando a la celda ${proposal.target}…`)
    const res = await window.bridge.delegateFromCell({
      target: /^\d+$/.test(proposal.target!) ? Number(proposal.target) : proposal.target!,
      message: proposal.text,
      fromCellId: cellId
    })
    if (res.error || !res.ok) {
      setMessages((ms) => [...ms, { role: 'error', text: `delegación falló: ${res.error}` }])
      return
    }
    sendText(
      `[Resultado de la delegación a la celda ${res.cell}]\n\n${res.text || '(sin texto)'}`
    )
  }

  // Responder al diálogo de permiso de acceso externo: avisa al main y marca la
  // tarjeta con la decisión. 'reject' finaliza la tarea; 'once'/'all' reanudan.
  const resolvePerm = (index: number, requestId: string, decision: 'once' | 'all' | 'reject'): void => {
    window.bridge.chatPermission(requestId, decision)
    setMessages((ms) =>
      ms.map((m, i) => (i === index && m.role === 'permission' && !m.decision ? { ...m, decision } : m))
    )
  }

  // Hay un permiso esperando decisión: bloquea el compositor para no arrancar
  // otro turno mientras el main espera la respuesta.
  const awaitingPerm = messages.some((m) => m.role === 'permission' && !m.decision)

  // display: lo que se muestra como burbuja del usuario (null = nada, p. ej.
  // el prompt interno de /compact); message: lo que viaja al agente.
  const sendText = (message: string, display: string | null = message): void => {
    if (!message || running) return
    // Primer mensaje de la conversación (también tras /new o /compact): es el
    // que define de qué va la celda. Se usa `display` porque `message` puede
    // llevar adjuntos internos (el resumen compactado, prompts del puente).
    if (display !== null && !sessionRef.current) {
      const t = titleFromPrompt(display)
      if (t) onAutoTitle(t)
    }
    if (display !== null) setMessages((ms) => [...ms, { role: 'user', text: display }])
    setRunning(true)
    onActivity('working')
    window.bridge
      .chatSend({
        id: cellId,
        agent,
        cwd,
        message,
        sessionId: sessionRef.current,
        permissionMode: permMode,
        model,
        effort
      })
      .catch((e) => {
        setRunning(false)
        onActivity('idle')
        setMessages((ms) => [...ms, { role: 'error', text: String(e) }])
      })
  }

  const send = (): void => {
    const message = input.trim()
    if (!message || running) return
    setInput('')
    if (message.startsWith('/') && handleSlash(message)) return
    if (pendingContextRef.current) {
      const wire = `[Resumen de la conversación anterior, compactada]\n${pendingContextRef.current}\n\n---\n\n${message}`
      pendingContextRef.current = null
      sendText(wire, message)
      return
    }
    sendText(message)
  }

  const ctxPct =
    ctx?.window && ctx.window > 0 ? Math.min(100, Math.round((ctx.tokens / ctx.window) * 100)) : null
  const ctxLevel = ctxPct === null ? '' : ctxPct >= 90 ? ' is-hot' : ctxPct >= 75 ? ' is-warn' : ''

  // Lo que el panel esconde sigue a la vista en la barra de estado: qué
  // permisos, qué modelo y qué effort está usando la celda ahora mismo.
  const configSummary =
    [
      agent === 'claude' ? PERM_LABELS[permMode] : null,
      model ?? (models.length > 0 ? 'modelo por defecto' : null),
      effort ? `effort ${effort}` : null
    ]
      .filter(Boolean)
      .join(' · ') || 'opciones del chat'

  return (
    <div
      className="chat-view"
      onDragOver={(e) => {
        if (e.dataTransfer.types.includes(CELL_MIME)) return
        e.preventDefault()
        e.dataTransfer.dropEffect = 'copy'
      }}
      onDrop={(e) => {
        if (e.dataTransfer.types.includes(CELL_MIME)) return
        e.preventDefault()
        const text = quotePaths(pathsFromDrop(e.dataTransfer))
        if (!text) return
        setInput((current) => (current ? `${current} ${text}` : text))
        inputRef.current?.focus()
      }}
    >
      <div ref={listRef} className="chat-list">
        {messages.length === 0 && (
          <div className="chat-empty">
            Chat agéntico con <b>{agent === 'claude' ? 'Claude Code' : 'OpenCode'}</b> en{' '}
            <code>{cwd}</code>. Escribe abajo para empezar — <code>/help</code> muestra los
            comandos.
          </div>
        )}
        {messages.map((m, i) => {
          if (m.role === 'user') {
            return (
              <div key={i} className="chat-user">
                {m.text}
              </div>
            )
          }
          if (m.role === 'remote-user') {
            return (
              <div key={i} className="chat-user chat-user-remote">
                <span className="chat-remote-from">📨 {m.name}</span>
                {m.text}
              </div>
            )
          }
          if (m.role === 'assistant') {
            return (
              <div
                key={i}
                className="chat-assistant md-body"
                dangerouslySetInnerHTML={{ __html: renderMarkdown(m.text) }}
              />
            )
          }
          if (m.role === 'proposal') {
            return (
              <div key={i} className="chat-proposal">
                <span className="chat-proposal-head">
                  🤝 El agente propone delegar a la celda {m.target}
                </span>
                <code>{m.text}</code>
                {m.state === 'pending' ? (
                  <div className="chat-proposal-actions">
                    <button className="chat-proposal-go" onClick={() => runProposal(i)}>
                      ▶ Delegar
                    </button>
                    <button
                      onClick={() =>
                        setMessages((ms) =>
                          ms.map((msg, j) => (j === i ? { ...msg, state: 'dismissed' as const } : msg))
                        )
                      }
                    >
                      ✕ Ignorar
                    </button>
                  </div>
                ) : (
                  <span className="chat-proposal-state">
                    {m.state === 'sent' ? '✓ delegada' : 'ignorada'}
                  </span>
                )}
              </div>
            )
          }
          if (m.role === 'permission') {
            return (
              <div key={i} className="chat-permission">
                <span className="chat-permission-head">
                  🔐 El agente pide acceso fuera del directorio de trabajo
                </span>
                {m.dirs && m.dirs.length > 0 && <code>{m.dirs.join('\n')}</code>}
                {!m.decision ? (
                  <div className="chat-permission-actions">
                    <button
                      className="chat-permission-go"
                      onClick={() => resolvePerm(i, m.requestId!, 'once')}
                    >
                      ✓ Aceptar este directorio
                    </button>
                    <button onClick={() => resolvePerm(i, m.requestId!, 'all')}>
                      ✓✓ Aceptar todo (bypass de la celda)
                    </button>
                    <button
                      className="chat-permission-reject"
                      onClick={() => resolvePerm(i, m.requestId!, 'reject')}
                    >
                      ✕ Rechazar
                    </button>
                  </div>
                ) : (
                  <span className="chat-permission-state">
                    {m.decision === 'reject'
                      ? '⛔ rechazado — tarea finalizada'
                      : m.decision === 'all'
                        ? '🔓 celda en bypass para el resto de la sesión'
                        : '✓ acceso autorizado — reanudando'}
                  </span>
                )}
              </div>
            )
          }
          if (m.role === 'thinking') {
            return (
              <details key={i} className="chat-thinking">
                <summary>🧠 razonamiento</summary>
                <div>{m.text}</div>
              </details>
            )
          }
          if (m.role === 'tool') {
            return (
              <div key={i} className="chat-tool">
                🔧 <b>{m.name}</b>
                {m.text && <code>{m.text}</code>}
              </div>
            )
          }
          if (m.role === 'error') {
            return (
              <div key={i} className="chat-error">
                ⚠ {m.text}
              </div>
            )
          }
          return (
            <div key={i} className="chat-meta">
              {m.text}
            </div>
          )
        })}
        {running && (
          <div className="chat-working">
            <span className="chat-spinner" /> trabajando… {elapsed}s
            <button onClick={() => window.bridge.chatCancel(cellId)}>■ Cancelar</button>
          </div>
        )}
      </div>
      {sessions && (
        <div className="chat-sessions">
          <div className="chat-sessions-head">
            <span>Sesiones anteriores en este directorio</span>
            <button className="icon-btn" onClick={() => setSessions(null)}>
              ✕
            </button>
          </div>
          <ul>
            {sessions.map((s) => (
              <li key={s.id} onClick={() => pickSession(s)}>
                <span className="chat-session-summary">{s.summary || s.id.slice(0, 8)}</span>
                <span className="chat-session-date">
                  {new Date(s.mtimeMs).toLocaleString('es-CO', {
                    day: '2-digit',
                    month: 'short',
                    hour: '2-digit',
                    minute: '2-digit'
                  })}
                </span>
              </li>
            ))}
          </ul>
        </div>
      )}
      {modelPicker && (
        <Palette
          placeholder="Filtrar modelos…"
          onClose={() => setModelPicker(false)}
          commands={[
            {
              id: '__default__',
              label: 'modelo por defecto',
              hint: model === null ? 'actual' : 'el que use el agente',
              run: () => onModel(null)
            },
            ...models.map((m) => ({
              id: m,
              label: m,
              hint: m === model ? 'actual' : undefined,
              run: () => onModel(m)
            }))
          ]}
        />
      )}
      <div className="chat-bottom" ref={bottomRef}>
        {optsOpen && (
          <div className="chat-opts">
            {agent === 'claude' && (
              <label className="chat-opt">
                <span>Permisos</span>
                <select
                  value={permMode}
                  onChange={(e) => setPermMode(e.target.value as ChatPerm)}
                >
                  {(Object.keys(PERM_LABELS) as Array<keyof typeof PERM_LABELS>).map((k) => (
                    <option key={k} value={k}>
                      {PERM_LABELS[k]}
                    </option>
                  ))}
                </select>
              </label>
            )}
            {models.length > 0 && (
              <div className="chat-opt">
                <span>Modelo</span>
                {/* Buscador en vez de <select>: OpenCode expone cientos de
                    modelos y la lista desplegada no cabía en la pantalla. */}
                <button
                  className="chat-opt-value"
                  title={model ?? 'el que use el agente por defecto'}
                  onClick={() => {
                    setOptsOpen(false)
                    setModelPicker(true)
                  }}
                >
                  <span>{model ?? 'modelo por defecto'}</span>
                  <span className="chat-opt-caret">⌄</span>
                </button>
              </div>
            )}
            {EFFORT_OPTIONS[agent].length > 0 && (
              <label className="chat-opt" title="claude --effort / opencode --variant">
                <span>Razonamiento</span>
                <select value={effort ?? ''} onChange={(e) => onEffort(e.target.value || null)}>
                  <option value="">effort auto</option>
                  {EFFORT_OPTIONS[agent].map((ef) => (
                    <option key={ef} value={ef}>
                      {ef}
                    </option>
                  ))}
                </select>
              </label>
            )}
            {agent === 'claude' && (
              <button
                className="chat-opt-action"
                onClick={() => {
                  setOptsOpen(false)
                  handleSlash('/resume')
                }}
              >
                ↺ Sesiones anteriores…
              </button>
            )}
          </div>
        )}
        <div className="chat-status">
          <button
            className="chat-status-config"
            title="Permisos, modelo y razonamiento de este chat"
            onClick={() => setOptsOpen((open) => !open)}
          >
            {configSummary}
          </button>
          {ctx && (
            <span
              className={`chat-ctx${ctxLevel}`}
              title={
                ctx.window
                  ? `Contexto de la conversación: ${ctx.tokens.toLocaleString('es-CO')} de ` +
                    `${ctx.window.toLocaleString('es-CO')} tokens · quedan ` +
                    `${Math.max(0, ctx.window - ctx.tokens).toLocaleString('es-CO')} libres`
                  : `Contexto de la conversación: ${ctx.tokens.toLocaleString('es-CO')} tokens ` +
                    '(el tamaño de la ventana del modelo se conoce al terminar el primer turno)'
              }
            >
              {ctxPct !== null && (
                <span className="chat-ctx-bar">
                  <span style={{ width: `${ctxPct}%` }} />
                </span>
              )}
              ctx {fmtCtx(ctx.tokens)}
              {ctx.window ? ` / ${fmtCtx(ctx.window)}` : ''}
              {ctxPct !== null && <b> {ctxPct}%</b>}
            </span>
          )}
        </div>
        <div className="chat-composer">
          <button
            className={`chat-opts-btn${optsOpen ? ' open' : ''}`}
            title={`Opciones del chat — ${configSummary}`}
            onClick={() => setOptsOpen((open) => !open)}
          >
            <svg viewBox="0 0 12 12" width="12" height="12" aria-hidden="true">
              <path
                d="M2.5 7.5 6 4l3.5 3.5"
                fill="none"
                stroke="currentColor"
                strokeWidth="1.7"
                strokeLinecap="round"
                strokeLinejoin="round"
              />
            </svg>
          </button>
          <textarea
            ref={inputRef}
            value={input}
            rows={2}
            placeholder={
              awaitingPerm
                ? 'Esperando tu autorización…'
                : running
                  ? 'El agente está trabajando…'
                  : 'Escribe un mensaje (Enter envía)'
            }
            disabled={running || awaitingPerm}
            spellCheck={false}
            onChange={(e) => setInput(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === 'Enter' && !e.shiftKey) {
                e.preventDefault()
                send()
              }
            }}
          />
          <button
            className="chat-send"
            onClick={send}
            disabled={running || awaitingPerm || !input.trim()}
          >
            ➤
          </button>
        </div>
      </div>
    </div>
  )
}
