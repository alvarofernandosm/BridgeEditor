import { useEffect, useRef, useState } from 'react'
import { renderMarkdown } from './highlight'
import { CELL_MIME, pathsFromDrop, quotePaths } from './dnd'
import { titleFromPrompt } from './titles'
import { detectAsk, type AskOption } from './ask'
import { useFocusOnRequest } from './focus'
import { parseDelegations } from './delegate'
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
    | 'ask'
  text: string
  name?: string
  /** Para 'proposal': celda destino del @delegate. */
  target?: string
  /** Para 'proposal' y 'ask': pending | sent | dismissed */
  state?: 'pending' | 'sent' | 'dismissed'
  /** Para 'ask': alternativas ofrecidas y la elegida. */
  options?: AskOption[]
  chosen?: string
  /** Para 'permission': id de la solicitud y directorios externos pedidos. */
  requestId?: string
  dirs?: string[]
  /** Para 'permission': decisión tomada (undefined = aún pendiente). */
  decision?: 'once' | 'all' | 'reject'
  /** Para 'user': entregado al turno que ya estaba corriendo, no como turno propio. */
  live?: boolean
}

/** Mensaje escrito mientras el agente trabajaba: espera turno para salir. */
interface QueuedMsg {
  id: string
  text: string
}

/** Remitente de los `remote-user` que emite el puente por su cuenta (las
 *  continuaciones automáticas de un turno delegado). Las delegaciones reales
 *  llegan con la etiqueta de la celda origen. Ver `from` en src/main/chat.ts. */
const BRIDGE_SENDER = 'BridgeEditor'


type ChatPerm = 'plan' | 'edits' | 'flexible' | 'full'

interface ChatViewProps {
  cellId: string
  /** Número de celda que ve el usuario: es el que usan los marcadores @delegate. */
  cellIndex: number
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
  /** Fecha ya formateada por el CLI del agente (opencode); claude usa mtimeMs. */
  when?: string
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

/** Agrega la tarjeta de opciones si la última respuesta del turno pregunta. */
function withAskCard(ms: ChatMsg[]): ChatMsg[] {
  const last = ms.map((m) => m.role).lastIndexOf('assistant')
  if (last < 0) return ms
  if (ms.slice(last).some((m) => m.role === 'ask')) return ms // ya tiene tarjeta
  const found = detectAsk(ms[last].text)
  if (!found) return ms
  const next = [...ms]
  if (found.cleaned !== next[last].text) next[last] = { ...next[last], text: found.cleaned }
  next.push({
    role: 'ask',
    text: found.ask.question ?? '',
    options: found.ask.options,
    state: 'pending'
  })
  return next
}

const fmtCtx = (n: number): string =>
  n >= 1_000_000 ? `${(n / 1_000_000).toFixed(2)}M` : n >= 1000 ? `${Math.round(n / 1000)}k` : String(n)

export function ChatView({
  cellId,
  cellIndex,
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
  // Mensajes escritos durante un turno: salen solos en cuanto la celda queda
  // libre (evento 'idle'), en el orden en que se escribieron.
  const [queued, setQueued] = useState<QueuedMsg[]>([])
  // Un turno que falló de verdad frena la cola: encadenar mensajes sobre una
  // sesión rota repite el mismo fallo tantas veces como haya en cola.
  const [queueHeld, setQueueHeld] = useState(false)
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
  // El número de celda cambia al cerrar o reordenar vecinas, y el listener de
  // eventos se registra una sola vez: por ref para que lea el de ahora.
  const cellIndexRef = useRef(cellIndex)
  cellIndexRef.current = cellIndex
  // /compact: true mientras esperamos el resumen; el resumen listo se adjunta
  // como contexto al próximo mensaje del usuario en la sesión nueva.
  const compactingRef = useRef(false)
  const pendingContextRef = useRef<string | null>(null)
  const ctxRef = useRef<CtxUsage | null>(ctx)
  // running en forma de ref: el guard de sendText tiene que leer el valor de
  // este instante, no el del render (la cola despacha dentro del mismo tick en
  // que el turno terminó).
  const runningRef = useRef(false)
  // Error del último 'done'. La cola se frena por cómo QUEDÓ el turno, no por
  // un tropiezo intermedio: un truncado reintentable emite su error y después
  // el propio main reanuda y termina bien.
  const lastErrorRef = useRef<string | null>(null)

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
          // delegada es lo que mejor la describe. Los avisos que el propio
          // puente manda por este canal (las continuaciones automáticas) no son
          // la tarea: sin filtrarlos, una celda que aún no tiene título acaba
          // titulada "⟳ Continuación automática 1/2: el turno anterior…".
          if (!titledRef.current && ev.from !== BRIDGE_SENDER) {
            const t = titleFromPrompt(ev.text, { delegated: true })
            if (t) onAutoTitle(t)
          }
          break
        }
        case 'turn-start':
          runningRef.current = true
          lastErrorRef.current = null
          setRunning(true)
          onActivity('working')
          break
        case 'text': {
          setMessages((ms) => {
            const next: ChatMsg[] = [...ms, { role: 'assistant', text: ev.text }]
            // marcadores @delegate del agente → tarjetas de propuesta
            const { proposals, selfTargets } = parseDelegations(ev.text, {
              index: cellIndexRef.current,
              cellId
            })
            for (const p of proposals) {
              next.push({ role: 'proposal', target: p.target, text: p.task, state: 'pending' })
            }
            // Decirlo en vez de tragárselo: si el agente se equivocó de número,
            // el silencio deja la delegación perdida sin que nadie se entere.
            for (const t of selfTargets) {
              next.push({
                role: 'meta',
                text: `marcador @delegate(${t}, …) ignorado: esa celda es esta misma`
              })
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
          // El turno NO terminó (el main espera la decisión), pero la celda no
          // está avanzando: para el resto de la app cuenta como parada.
          onActivity('idle')
          setMessages((ms) => [...ms, { role: 'permission', text: '', requestId: ev.requestId, dirs: ev.dirs }])
          if (!activeRef.current) onAttention()
          break
        case 'done':
          // 'done' cierra un turno de proceso, no la actividad de la celda: tras
          // autorizar un permiso o en una continuación automática vienen más.
          // Quien para el reloj es 'idle'.
          lastErrorRef.current = ev.error ?? null
          if (ev.sessionId) {
            sessionRef.current = ev.sessionId
            onSessionId(ev.sessionId)
            rememberCtx(ctxRef.current)
          }
          if (ev.error) setMessages((ms) => [...ms, { role: 'error', text: ev.error! }])
          else if (ev.meta) setMessages((ms) => [...ms, { role: 'meta', text: ev.meta! }])
          // ¿El turno terminó preguntando? Se mira sólo la última respuesta: una
          // lista enumerada a mitad de camino no es una pregunta al usuario.
          if (!ev.error && !compactingRef.current) setMessages(withAskCard)
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
        case 'idle':
          // Fin real del turno: aquí para el reloj y se destraba la cola —
          // salvo que el turno haya terminado mal, y entonces se frena.
          runningRef.current = false
          setRunning(false)
          if (lastErrorRef.current) setQueueHeld(true)
          onActivity('idle')
          break
        case 'error':
          runningRef.current = false
          lastErrorRef.current = ev.message
          setRunning(false)
          setQueueHeld(true)
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

  // El compositor ya no se apaga durante el turno (se puede encolar), así que
  // la celda activa reclama el teclado esté trabajando o no.
  useEffect(() => {
    if (active) inputRef.current?.focus()
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

  // Reclamar el teclado cuando otra celda se cierra (ver App.closeCell).
  useFocusOnRequest(cellId, () => inputRef.current?.focus())

  const addMeta = (text: string): void => setMessages((ms) => [...ms, { role: 'meta', text }])

  const enqueue = (text: string): void =>
    setQueued((q) => [...q, { id: crypto.randomUUID(), text }])

  /**
   * Mensaje escrito con la celda ocupada. Se intenta la entrega en vivo (claude
   * lee stdin mientras trabaja y el modelo lo atiende en su siguiente paso, sin
   * esperar el cierre del turno); si el agente no la admite, espera en la cola.
   * Entra a la cola desde ya para que se vea de inmediato, y sale de ella si la
   * entrega prospera.
   */
  const deliverNow = (text: string): void => {
    const item = { id: crypto.randomUUID(), text }
    setQueued((q) => [...q, item])
    window.bridge
      .chatPush(cellId, text)
      .then((delivered) => {
        if (!delivered) return
        setQueued((q) => q.filter((m) => m.id !== item.id))
        setMessages((ms) => [...ms, { role: 'user', text, live: true }])
      })
      .catch(() => {
        // sin canal en vivo se queda en la cola, que es el camino normal
      })
  }

  // Pinta el historial guardado de una sesión de Claude. Sin esto, retomar una
  // conversación dejaba el chat en blanco y no había forma de reconocerla.
  const showTranscript = (id: string, head: string): void => {
    setMessages([{ role: 'meta', text: `${head} · cargando historial…` }])
    window.bridge
      .chatTranscript(agent, cwd, id)
      .then(({ messages: history, total }) => {
        // `total` cuenta el diálogo; los chips de herramienta no entran.
        const shown = history.filter((m) => m.role !== 'tool').length
        const header =
          shown === 0
            ? `${head} (sin historial guardado)`
            : shown < total
              ? `${head} · últimos ${shown} de ${total} mensajes`
              : head
        setMessages([
          { role: 'meta', text: header },
          ...history.map((m) => ({ role: m.role, text: m.text, name: m.name }) as ChatMsg)
        ])
      })
      .catch(() => setMessages([{ role: 'meta', text: head }]))
  }

  const pickSession = (s: SessionInfo): void => {
    sessionRef.current = s.id
    onSessionId(s.id)
    setSessions(null)
    const saved = loadCtx(s.id)
    setCtx(saved)
    ctxRef.current = saved
    showTranscript(s.id, `sesión retomada: ${s.summary || s.id.slice(0, 8)}`)
  }

  // Al restaurar el layout la celda vuelve con su sesión: mostrar de qué venía.
  // 'continue' es el marcador legado de opencode (antes de rastrear el id real)
  // y no identifica ninguna sesión exportable.
  useEffect(() => {
    if (!sessionId || sessionId === 'continue') return
    if (agent === 'claude' || agent === 'opencode') {
      showTranscript(sessionId, 'continuando la sesión anterior')
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [])

  const resetConversation = (): void => {
    sessionRef.current = null
    pendingContextRef.current = null
    // Empezar de cero incluye lo que estaba esperando turno: esos mensajes se
    // escribieron para la conversación que se acaba de tirar.
    setQueued([])
    setQueueHeld(false)
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
      if (agent !== 'claude' && agent !== 'opencode') {
        addMeta('solo disponible en chats de Claude Code y OpenCode')
        return true
      }
      window.bridge.chatSessions(agent, cwd).then((list) => {
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
    const report = `[Resultado de la delegación a la celda ${res.cell}]\n\n${res.text || '(sin texto)'}`
    // Delegar tarda, y en ese rato el usuario pudo arrancar otro turno: el
    // resultado entra a la cola en vez de perderse (sendText lo descartaría).
    if (runningRef.current) enqueue(report)
    else sendText(report)
  }

  // Responder al diálogo de permiso de acceso externo: avisa al main y marca la
  // tarjeta con la decisión. 'reject' finaliza la tarea; 'once'/'all' reanudan.
  const resolvePerm = (index: number, requestId: string, decision: 'once' | 'all' | 'reject'): void => {
    window.bridge.chatPermission(requestId, decision)
    setMessages((ms) =>
      ms.map((m, i) => (i === index && m.role === 'permission' && !m.decision ? { ...m, decision } : m))
    )
  }

  // Hay un permiso esperando decisión: el main está detenido esperándola, así
  // que no se puede arrancar otro turno (escribir sí: se encola).
  const awaitingPerm = messages.some((m) => m.role === 'permission' && !m.decision)

  // display: lo que se muestra como burbuja del usuario (null = nada, p. ej.
  // el prompt interno de /compact); message: lo que viaja al agente.
  const sendText = (message: string, display: string | null = message): void => {
    if (!message || runningRef.current) return
    // Primer mensaje de la conversación (también tras /new o /compact): es el
    // que define de qué va la celda. Se usa `display` porque `message` puede
    // llevar adjuntos internos (el resumen compactado, prompts del puente).
    if (display !== null && !sessionRef.current) {
      const t = titleFromPrompt(display)
      if (t) onAutoTitle(t)
    }
    if (display !== null) setMessages((ms) => [...ms, { role: 'user', text: display }])
    runningRef.current = true
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
      .then((res) => {
        // La celda ya estaba ocupada (una delegación entrante se metió primero):
        // el main no lanzó nada, así que el mensaje se deshace y vuelve a la cola
        // en vez de perderse. Sin esto la burbuja quedaría en pantalla como si
        // se hubiera enviado.
        if (!res?.busy) return
        runningRef.current = false
        setRunning(false)
        if (display !== null) {
          setMessages((ms) => {
            const last = ms[ms.length - 1]
            return last?.role === 'user' && last.text === display ? ms.slice(0, -1) : ms
          })
        }
        setQueued((q) => [{ id: crypto.randomUUID(), text: message }, ...q])
      })
      .catch((e) => {
        runningRef.current = false
        setRunning(false)
        setQueueHeld(true)
        onActivity('idle')
        setMessages((ms) => [...ms, { role: 'error', text: String(e) }])
      })
  }

  // Elegir una opción de una tarjeta de pregunta: se envía como un mensaje del
  // usuario normal (el agente no distingue el clic de haberlo escrito a mano).
  const answerAsk = (index: number, option: AskOption): void => {
    if (running) return
    setMessages((ms) =>
      ms.map((m, i) =>
        i === index && m.role === 'ask' && m.state === 'pending'
          ? { ...m, state: 'sent' as const, chosen: option.label }
          : m
      )
    )
    sendText(option.label)
  }

  const dismissAsk = (index: number): void => {
    setMessages((ms) => ms.map((m, i) => (i === index ? { ...m, state: 'dismissed' as const } : m)))
    inputRef.current?.focus()
  }

  // Camino de un mensaje del usuario con la celda libre. La cola pasa por aquí
  // también: un '/new' encolado tiene que ejecutarse como comando, no viajar
  // literal al agente, y el resumen de /compact tiene que engancharse al primer
  // mensaje de la sesión nueva aunque ese mensaje venga de la cola.
  const submit = (message: string): void => {
    if (message.startsWith('/') && handleSlash(message)) return
    if (pendingContextRef.current) {
      const wire = `[Resumen de la conversación anterior, compactada]\n${pendingContextRef.current}\n\n---\n\n${message}`
      pendingContextRef.current = null
      sendText(wire, message)
      return
    }
    sendText(message)
  }

  // La celda no puede arrancar un turno ahora: o hay uno corriendo, o el main
  // está esperando que el usuario resuelva un permiso.
  const busy = running || awaitingPerm

  // La cola sale sola en cuanto la celda queda libre. Va por efecto y no dentro
  // del evento 'idle' a propósito: así también arranca cuando lo que destraba
  // es otra cosa (se resolvió el permiso, se reanudó la cola tras un error, o
  // el mensaje rebotó porque una delegación se había metido primero).
  useEffect(() => {
    if (busy || queueHeld || queued.length === 0) return
    const [next, ...rest] = queued
    setQueued(rest)
    // El turno terminó preguntando y ya había algo escrito: ese mensaje es la
    // respuesta, así que la tarjeta de opciones se retira (igual que en el CLI).
    setMessages((ms) =>
      ms.map((m) => (m.role === 'ask' && m.state === 'pending' ? { ...m, state: 'dismissed' } : m))
    )
    submit(next.text)
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [busy, queueHeld, queued])

  /** steer = no esperar: se corta el turno actual y la cola arranca enseguida. */
  const send = (steer = false): void => {
    const message = input.trim()
    if (!message) return
    setInput('')
    // Escribir es retomar el control: si la cola estaba frenada por un error,
    // este mensaje la reanuda.
    setQueueHeld(false)
    if (busy) {
      // steer = el usuario quiere cortar lo que el agente está haciendo, no solo
      // sumar contexto: ahí se cancela y el mensaje sale como turno nuevo.
      if (steer) {
        enqueue(message)
        window.bridge.chatCancel(cellId)
      } else {
        deliverNow(message)
      }
      return
    }
    submit(message)
  }

  /** Manda este mensaje al frente de la cola y corta el turno en curso. */
  const steerNow = (id: string): void => {
    setQueued((q) => {
      const found = q.find((m) => m.id === id)
      return found ? [found, ...q.filter((m) => m.id !== id)] : q
    })
    setQueueHeld(false)
    window.bridge.chatCancel(cellId)
  }

  const editQueued = (id: string): void => {
    const found = queued.find((m) => m.id === id)
    if (!found) return
    setQueued((q) => q.filter((m) => m.id !== id))
    setInput((current) => (current ? `${found.text}\n${current}` : found.text))
    inputRef.current?.focus()
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
                {m.live && <span className="chat-user-live">⚡ entregado al turno en curso</span>}
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
          if (m.role === 'ask') {
            return (
              <div key={i} className="chat-ask">
                <span className="chat-ask-head">
                  🤔 {m.text || 'El agente necesita que elijas'}
                </span>
                {m.state === 'pending' ? (
                  <div className="chat-ask-actions">
                    {(m.options ?? []).map((o, k) => (
                      <button
                        key={k}
                        className="chat-ask-option"
                        title={o.detail || o.label}
                        disabled={running}
                        onClick={() => answerAsk(i, o)}
                      >
                        {o.label}
                      </button>
                    ))}
                    <button className="chat-ask-skip" onClick={() => dismissAsk(i)}>
                      ✎ responder a mano
                    </button>
                  </div>
                ) : (
                  <span className="chat-ask-state">
                    {m.state === 'sent' ? `✓ elegiste: ${m.chosen}` : 'respondiendo a mano'}
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
        {running && !awaitingPerm && (
          <div className="chat-working">
            <span className="chat-spinner" /> trabajando… {elapsed}s
            <button onClick={() => window.bridge.chatCancel(cellId)}>■ Cancelar</button>
          </div>
        )}
        {queued.map((q, n) => (
          <div key={q.id} className="chat-queued">
            <span className="chat-queued-head">
              ⏳ En cola{queued.length > 1 ? ` · ${n + 1} de ${queued.length}` : ''}
              {queueHeld && n === 0 ? ' · esperando a que retomes tras el error' : ''}
            </span>
            <span className="chat-queued-text">{q.text}</span>
            <div className="chat-queued-actions">
              {busy && (
                <button
                  className="chat-queued-now"
                  title="Corta el turno actual y manda este mensaje enseguida"
                  onClick={() => steerNow(q.id)}
                >
                  ⚡ Enviar ya
                </button>
              )}
              {queueHeld && !busy && (
                <button className="chat-queued-now" onClick={() => setQueueHeld(false)}>
                  ▶ Reanudar la cola
                </button>
              )}
              <button onClick={() => editQueued(q.id)}>✎ Editar</button>
              <button onClick={() => setQueued((qs) => qs.filter((m) => m.id !== q.id))}>
                🗑 Quitar
              </button>
            </div>
          </div>
        ))}
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
                  {s.when ??
                    new Date(s.mtimeMs).toLocaleString('es-CO', {
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
            {(agent === 'claude' || agent === 'opencode') && (
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
              !busy
                ? 'Escribe un mensaje (Enter envía)'
                : agent === 'claude'
                  ? 'Enter se lo pasa al turno en curso · Ctrl+Enter lo corta y envía'
                  : 'Enter encola · Ctrl+Enter corta el turno y envía ya'
            }
            spellCheck={false}
            onChange={(e) => setInput(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === 'Enter' && !e.shiftKey) {
                e.preventDefault()
                send(e.ctrlKey || e.metaKey)
              }
            }}
          />
          <button
            className="chat-send"
            title={busy ? 'Encolar (Ctrl+Enter para enviar ya)' : 'Enviar'}
            onClick={() => send()}
            disabled={!input.trim()}
          >
            {busy ? '⏳' : '➤'}
          </button>
        </div>
      </div>
    </div>
  )
}
