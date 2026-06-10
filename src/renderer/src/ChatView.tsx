import { useEffect, useRef, useState } from 'react'
import { renderMarkdown } from './highlight'
import type { AgentKind } from './App'

interface ChatMsg {
  role: 'user' | 'remote-user' | 'assistant' | 'thinking' | 'tool' | 'meta' | 'error' | 'proposal'
  text: string
  name?: string
  /** Para 'proposal': celda destino del @delegate. */
  target?: string
  /** Para 'proposal': pending | sent | dismissed */
  state?: 'pending' | 'sent' | 'dismissed'
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
  onModel: (model: string | null) => void
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
  '/new — conversación nueva · /help — esta ayuda. Cualquier otro /comando se envía ' +
  'al agente (tus comandos personalizados de .claude/commands funcionan).'

const PERM_LABELS: Record<ChatPerm, string> = {
  plan: 'solo planear',
  edits: 'acepta ediciones',
  flexible: 'flexible (solo crítico)',
  full: 'sin preguntar'
}

export function ChatView({
  cellId,
  agent,
  cwd,
  active,
  initialPerm,
  sessionId,
  model,
  onModel,
  onSessionId,
  onActivity,
  onAttention
}: ChatViewProps): JSX.Element {
  const [messages, setMessages] = useState<ChatMsg[]>(() =>
    sessionId && agent === 'claude'
      ? [{ role: 'meta', text: 'continuando la sesión anterior' }]
      : []
  )
  const [input, setInput] = useState('')
  const [running, setRunning] = useState(false)
  const [elapsed, setElapsed] = useState(0)
  const [permMode, setPermMode] = useState<ChatPerm>(initialPerm)
  const [sessions, setSessions] = useState<SessionInfo[] | null>(null)
  const [models, setModels] = useState<string[]>([])

  useEffect(() => {
    window.bridge.chatModels(agent).then(setModels)
  }, [agent])
  const listRef = useRef<HTMLDivElement>(null)
  const inputRef = useRef<HTMLTextAreaElement>(null)
  const sessionRef = useRef(sessionId)
  const activeRef = useRef(active)
  activeRef.current = active

  useEffect(() => {
    const off = window.bridge.onChatEvent(cellId, (ev) => {
      switch (ev.kind) {
        case 'init':
          sessionRef.current = ev.sessionId
          onSessionId(ev.sessionId)
          break
        case 'remote-user':
          setMessages((ms) => [...ms, { role: 'remote-user', text: ev.text, name: ev.from }])
          break
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
        case 'done':
          setRunning(false)
          onActivity('idle')
          if (ev.sessionId) {
            sessionRef.current = ev.sessionId
            onSessionId(ev.sessionId)
          }
          if (ev.error) setMessages((ms) => [...ms, { role: 'error', text: ev.error! }])
          else if (ev.meta) setMessages((ms) => [...ms, { role: 'meta', text: ev.meta! }])
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
    setMessages([{ role: 'meta', text: `sesión retomada: ${s.summary || s.id.slice(0, 8)}` }])
  }

  const resetConversation = (): void => {
    sessionRef.current = null
    onSessionId(null)
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

  const sendText = (message: string): void => {
    if (!message || running) return
    setMessages((ms) => [...ms, { role: 'user', text: message }])
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
        model
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
    sendText(message)
  }

  return (
    <div className="chat-view">
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
      <div className="chat-composer">
        {agent === 'claude' && (
          <button
            className="chat-resume-btn"
            title="Sesiones anteriores (/resume)"
            onClick={() => handleSlash('/resume')}
          >
            ↺
          </button>
        )}
        {agent === 'claude' && (
          <select
            value={permMode}
            title="Permisos del agente en este chat"
            onChange={(e) => setPermMode(e.target.value as ChatPerm)}
          >
            {(Object.keys(PERM_LABELS) as Array<keyof typeof PERM_LABELS>).map((k) => (
              <option key={k} value={k}>
                {PERM_LABELS[k]}
              </option>
            ))}
          </select>
        )}
        {models.length > 0 && (
          <select
            className="chat-model"
            value={model ?? ''}
            title="Modelo de este chat"
            onChange={(e) => onModel(e.target.value || null)}
          >
            <option value="">modelo por defecto</option>
            {models.map((m) => (
              <option key={m} value={m}>
                {m}
              </option>
            ))}
          </select>
        )}
        <textarea
          ref={inputRef}
          value={input}
          rows={2}
          placeholder={running ? 'El agente está trabajando…' : 'Escribe un mensaje (Enter envía)'}
          disabled={running}
          spellCheck={false}
          onChange={(e) => setInput(e.target.value)}
          onKeyDown={(e) => {
            if (e.key === 'Enter' && !e.shiftKey) {
              e.preventDefault()
              send()
            }
          }}
        />
        <button className="chat-send" onClick={send} disabled={running || !input.trim()}>
          ➤
        </button>
      </div>
    </div>
  )
}
