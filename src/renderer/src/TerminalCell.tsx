import { useCallback, useEffect, useRef, useState } from 'react'
import { Terminal, type ILink } from '@xterm/xterm'
import { FitAddon } from '@xterm/addon-fit'
import { WebLinksAddon } from '@xterm/addon-web-links'
import '@xterm/xterm/css/xterm.css'
import type { AgentKind, CellState } from './App'
import { CELL_MIME, pathsFromDrop, quotePaths } from './dnd'
import { Launcher } from './Launcher'
import { FileView } from './FileView'
import { ChatView } from './ChatView'
import { cleanTerminalTitle } from './titles'
import { useFocusOnRequest } from './focus'

export const AGENTS: Record<AgentKind, { label: string; command: string | null; color: string }> = {
  claude: { label: 'Claude Code', command: 'claude', color: '#d97757' },
  opencode: { label: 'OpenCode', command: 'opencode', color: '#4ec9b0' },
  antigravity: { label: 'Antigravity', command: 'agy', color: '#8ab4f8' },
  shell: { label: 'Shell', command: null, color: '#9cdcfe' }
}

interface TerminalCellProps {
  cell: CellState
  index: number
  active: boolean
  onActivate: (id: string) => void
  onClose: (id: string) => void
  onUpdate: (id: string, patch: Partial<CellState>) => void
  onOpenFile: (path: string) => void
}

export function TerminalCell({
  cell,
  index,
  active,
  onActivate,
  onClose,
  onUpdate,
  onOpenFile
}: TerminalCellProps): JSX.Element {
  const agent = cell.agent ? AGENTS[cell.agent] : null
  const ptyId = `${cell.id}-g${cell.generation}`
  // Título de la tarea: el manual gana sobre el deducido por la celda.
  const task = cell.title ?? cell.autoTitle ?? null
  const [editingTitle, setEditingTitle] = useState(false)
  const [titleDraft, setTitleDraft] = useState('')

  // Un launcher no está haciendo nada y un visor ya se llama como su archivo.
  const canTitle = cell.agent !== null && cell.status !== 'file'

  const startEditingTitle = useCallback(() => {
    if (!canTitle) return
    setTitleDraft(cell.title ?? cell.autoTitle ?? '')
    setEditingTitle(true)
  }, [canTitle, cell.title, cell.autoTitle])

  const commitTitle = (): void => {
    const value = titleDraft.trim()
    // Vaciar el campo devuelve la celda al título automático.
    onUpdate(cell.id, { title: value || null })
    setEditingTitle(false)
  }

  // "✎ Titular la celda activa…" desde la paleta o el menú.
  useEffect(() => {
    const onRename = (e: Event): void => {
      const detail = (e as CustomEvent).detail as { cellId: string }
      if (detail.cellId === cell.id) startEditingTitle()
    }
    window.addEventListener('bridge:rename-cell', onRename)
    return () => window.removeEventListener('bridge:rename-cell', onRename)
  }, [cell.id, startEditingTitle])

  const dotColor =
    cell.status !== 'running'
      ? '#f85149'
      : cell.attention
        ? '#e3b341'
        : cell.activity === 'working'
          ? '#3fb950'
          : '#58a6ff'

  return (
    <section
      className={`cell ${active ? 'cell-active' : ''} ${cell.attention ? 'cell-attention' : ''}`}
      onMouseDown={() => onActivate(cell.id)}
    >
      <header
        className="cell-header"
        title="Arrastra para intercambiar la posición con otra celda"
        // Con el editor de título abierto el drag se apaga: si no, el header
        // captura el mouse y no se puede ni seleccionar texto en el input.
        draggable={!editingTitle}
        onDragStart={(e) => {
          e.dataTransfer.setData(CELL_MIME, cell.id)
          e.dataTransfer.effectAllowed = 'move'
        }}
      >
        <span className="cell-index">{index + 1}</span>
        {cell.status === 'file' && cell.file ? (
          <>
            <span className="cell-title" style={{ color: '#e3b341' }}>
              📄 {cell.file.split(/[\\/]/).pop()}
            </span>
            <span className="cell-cwd" title={cell.file}>
              {cell.file}
            </span>
          </>
        ) : agent ? (
          <>
            <span
              className={`status-dot ${cell.attention ? 'dot-pulse' : ''}`}
              title={
                cell.status !== 'running'
                  ? 'terminado'
                  : cell.attention
                    ? 'esperándote'
                    : cell.activity === 'working'
                      ? 'trabajando'
                      : 'quieto'
              }
              style={{ background: dotColor }}
            />
            <span
              className="cell-title"
              style={{ color: agent.color }}
              title="Doble clic para titular esta celda"
              onDoubleClick={startEditingTitle}
            >
              {cell.mode === 'chat' ? `💬 ${agent.label}` : agent.label}
            </span>
            {editingTitle ? (
              <input
                className="cell-task-input"
                autoFocus
                value={titleDraft}
                spellCheck={false}
                placeholder="¿En qué anda esta celda? (vacío = automático)"
                onMouseDown={(e) => e.stopPropagation()}
                onChange={(e) => setTitleDraft(e.target.value)}
                onBlur={commitTitle}
                onKeyDown={(e) => {
                  if (e.key === 'Enter') commitTitle()
                  else if (e.key === 'Escape') setEditingTitle(false)
                }}
              />
            ) : (
              task && (
                <span
                  className={`cell-task ${cell.title ? 'cell-task-manual' : ''}`}
                  title={`${task}\n\nDoble clic para editar (vacío = automático)`}
                  onDoubleClick={startEditingTitle}
                >
                  {task}
                </span>
              )
            )}
            <span className="cell-cwd" title={cell.cwd}>
              {cell.cwd}
            </span>
          </>
        ) : (
          <span className="cell-title muted">nueva sesión</span>
        )}
        <div className="spacer" />
        {cell.status === 'file' && (
          <button
            className="icon-btn"
            title="Volver al launcher"
            onClick={() => onUpdate(cell.id, { status: 'launcher', file: null })}
          >
            ↩
          </button>
        )}
        <button
          className="icon-btn"
          title="Cerrar celda"
          onClick={(e) => {
            const busy =
              cell.status === 'running' && (cell.mode === 'term' || cell.activity === 'working')
            if (busy && !window.confirm('Esta celda tiene un proceso corriendo. ¿Cerrarla y terminarlo?')) {
              return
            }
            // Soltar el foco antes de que el botón desaparezca con la celda: un
            // elemento enfocado que se destruye deja el teclado en el body, y
            // ahí el espacio y las mayúsculas se pierden hasta que la ventana
            // recupera el foco (ver el refoco en App.closeCell).
            e.currentTarget.blur()
            onClose(cell.id)
          }}
        >
          ✕
        </button>
      </header>
      <div
        className="cell-body"
        onDragOver={(e) => {
          if (e.dataTransfer.types.includes(CELL_MIME)) return
          if (cell.status === 'launcher' || cell.status === 'file') e.preventDefault()
        }}
        onDrop={(e) => {
          if (e.dataTransfer.types.includes(CELL_MIME)) return
          if (cell.status !== 'launcher' && cell.status !== 'file') return
          e.preventDefault()
          const path = pathsFromDrop(e.dataTransfer)[0]
          if (path) onUpdate(cell.id, { status: 'file', file: path })
        }}
      >
        {cell.status === 'launcher' && (
          <Launcher
            cellId={cell.id}
            onStart={(kind, cwd, mode, perm) =>
              onUpdate(cell.id, {
                agent: kind,
                cwd,
                mode,
                perm,
                resume: false,
                termSessionId: null,
                chatSessionId: null,
                status: 'running',
                exitCode: undefined
              })
            }
            onOpenFile={(path) => onUpdate(cell.id, { status: 'file', file: path })}
          />
        )}
        {cell.status === 'file' && cell.file && <FileView cellId={cell.id} path={cell.file} />}
        {cell.mode === 'chat' &&
          cell.status === 'running' &&
          cell.agent &&
          cell.agent !== 'shell' && (
            <ChatView
              cellId={cell.id}
              agent={cell.agent}
              cwd={cell.cwd}
              active={active}
              initialPerm={
                cell.perm === 'flexible' ? 'flexible' : cell.perm === 'yolo' ? 'full' : 'edits'
              }
              sessionId={cell.chatSessionId}
              model={cell.chatModel}
              effort={cell.chatEffort}
              titled={task !== null}
              onAutoTitle={(t) => onUpdate(cell.id, { autoTitle: t })}
              onModel={(m) => onUpdate(cell.id, { chatModel: m })}
              onEffort={(ef) => onUpdate(cell.id, { chatEffort: ef })}
              onSessionId={(sid) => onUpdate(cell.id, { chatSessionId: sid })}
              onActivity={(activity) => onUpdate(cell.id, { activity })}
              onAttention={() => onUpdate(cell.id, { attention: true })}
            />
          )}
        {cell.mode === 'term' && (cell.status === 'running' || cell.status === 'exited') && cell.agent && (
          <TerminalView
            key={ptyId}
            ptyId={ptyId}
            cellId={cell.id}
            command={AGENTS[cell.agent].command}
            cwd={cell.cwd}
            perm={cell.perm}
            resumeSession={cell.resume ? cell.termSessionId : null}
            active={active}
            onExit={(code) => onUpdate(cell.id, { status: 'exited', exitCode: code })}
            onSession={(sid) => onUpdate(cell.id, { termSessionId: sid })}
            onAutoTitle={(t) => {
              if (t !== cell.autoTitle) onUpdate(cell.id, { autoTitle: t })
            }}
            onActivity={(activity) => onUpdate(cell.id, { activity })}
            onAttention={() => onUpdate(cell.id, { attention: true })}
            onUserInput={() => {
              if (cell.attention) onUpdate(cell.id, { attention: false })
            }}
            onOpenFile={onOpenFile}
          />
        )}
        {cell.mode === 'term' && cell.status === 'exited' && (
          <div className="exit-overlay">
            <p>
              Proceso terminado{cell.exitCode !== undefined ? ` (código ${cell.exitCode})` : ''}
            </p>
            <div className="exit-actions">
              <button
                onClick={() =>
                  onUpdate(cell.id, { status: 'running', generation: cell.generation + 1 })
                }
              >
                ↻ Relanzar
              </button>
              <button onClick={() => onUpdate(cell.id, { agent: null, status: 'launcher' })}>
                Cambiar agente
              </button>
              <button onClick={() => onClose(cell.id)}>Cerrar celda</button>
            </div>
          </div>
        )}
      </div>
    </section>
  )
}

interface TerminalViewProps {
  ptyId: string
  cellId: string
  command: string | null
  cwd: string
  perm: CellState['perm']
  resumeSession: string | null
  active: boolean
  onExit: (code: number) => void
  onSession: (sessionId: string) => void
  /** Título OSC publicado por el TUI (Claude Code anuncia ahí su tarea). */
  onAutoTitle: (title: string) => void
  onActivity: (activity: 'working' | 'idle') => void
  onAttention: () => void
  onUserInput: () => void
  onOpenFile: (path: string) => void
}

/** Candidatos a ruta: absolutas, ~/, ./, ../ o relativas con extensión. */
const PATH_RE = /(?:~|\.{1,2})?\/[\w.@+~/-]+|(?:[\w.@+-]+\/)+[\w.@+-]+\.[A-Za-z]\w*/g

function TerminalView({
  ptyId,
  cellId,
  command,
  cwd,
  perm,
  resumeSession,
  active,
  onExit,
  onSession,
  onAutoTitle,
  onActivity,
  onAttention,
  onUserInput,
  onOpenFile
}: TerminalViewProps): JSX.Element {
  const containerRef = useRef<HTMLDivElement>(null)
  const termRef = useRef<Terminal | null>(null)
  const [flash, setFlash] = useState<string | null>(null)
  const flashTimerRef = useRef<number | undefined>(undefined)
  const cbRef = useRef({
    onExit,
    onSession,
    onAutoTitle,
    onActivity,
    onAttention,
    onUserInput,
    onOpenFile
  })
  cbRef.current = { onExit, onSession, onAutoTitle, onActivity, onAttention, onUserInput, onOpenFile }
  const activeRef = useRef(active)
  activeRef.current = active

  useEffect(() => {
    const el = containerRef.current
    if (!el) return

    const term = new Terminal({
      fontFamily: '"JetBrainsMono Nerd Font", "JetBrains Mono", "Fira Code", Menlo, Consolas, monospace',
      fontSize: 13,
      cursorBlink: true,
      scrollback: 10000,
      theme: {
        background: '#0d1117',
        foreground: '#e6edf3',
        cursor: '#58a6ff',
        selectionBackground: '#264f78',
        black: '#484f58',
        red: '#ff7b72',
        green: '#3fb950',
        yellow: '#d29922',
        blue: '#58a6ff',
        magenta: '#bc8cff',
        cyan: '#39c5cf',
        white: '#b1bac4',
        brightBlack: '#6e7681',
        brightRed: '#ffa198',
        brightGreen: '#56d364',
        brightYellow: '#e3b341',
        brightBlue: '#79c0ff',
        brightMagenta: '#d2a8ff',
        brightCyan: '#56d4dd',
        brightWhite: '#f0f6fc'
      }
    })

    // Cada rama avisa en pantalla: antes, copiar sin selección o un portapapeles
    // vacío no hacían nada y no había forma de distinguirlo de "el atajo no llegó".
    const showFlash = (msg: string): void => {
      setFlash(msg)
      window.clearTimeout(flashTimerRef.current)
      flashTimerRef.current = window.setTimeout(() => setFlash(null), 1800)
    }

    const alPortapapeles = (texto: string, origen: string): void => {
      try {
        window.bridge.writeClipboard(texto)
        showFlash(`✓ copiado · ${texto.length} caracteres${origen}`)
      } catch (err) {
        showFlash(`✗ no se pudo copiar: ${String(err)}`)
      }
    }

    const copySelection = (): void => {
      const sel = term.getSelection()
      if (sel) {
        alPortapapeles(sel, '')
        return
      }
      // xterm dice que no hay selección, pero puede haberla igual: en el DOM
      // (encabezado, avisos) o en el portapapeles primario, que se rellena en
      // cuanto arrastrás el mouse. Si la selección se perdió entre el arrastre y
      // la tecla, el texto sigue en el primario: copiarlo de ahí rescata el caso
      // y el aviso dice de dónde salió, así no se copia nada a ciegas.
      const dom = window.getSelection()?.toString() ?? ''
      if (dom) {
        alPortapapeles(dom, ' · de la página')
        return
      }
      const primario = window.bridge.platform === 'linux' ? window.bridge.readPrimary() : ''
      if (primario) {
        alPortapapeles(primario, ' · de la selección del mouse')
        return
      }
      // Con el mouse capturado por el TUI (Claude Code lo hace para su scroll y
      // sus clics) xterm le pasa el arrastre al agente y no selecciona nada. La
      // salida es la de toda terminal: Shift fuerza la selección local.
      showFlash(
        term.modes.mouseTrackingMode !== 'none'
          ? 'el agente tiene el mouse capturado — mantené Shift mientras arrastrás para seleccionar'
          : 'no hay nada seleccionado — arrastrá el mouse sobre el texto'
      )
    }
    const pasteClipboard = (): void => {
      let text = ''
      try {
        text = window.bridge.readClipboard()
      } catch (err) {
        showFlash(`✗ no se pudo leer el portapapeles: ${String(err)}`)
        return
      }
      if (!text) {
        showFlash('el portapapeles está vacío')
        return
      }
      // term.paste respeta el bracketed paste mode de los TUI.
      term.paste(text)
    }

    term.attachCustomKeyEventHandler((e) => {
      // Deja pasar Ctrl/Cmd+1..6 al atajo global de cambio de celda.
      if ((e.ctrlKey || e.metaKey) && e.key >= '1' && e.key <= '6') return false
      // Atajos globales que no deben llegar al TUI (las terminales no
      // distinguen Ctrl+Shift+letra de Ctrl+letra: si no se interceptan,
      // Ctrl+Shift+D se colaría como Ctrl+D = EOF).
      if ((e.ctrlKey || e.metaKey) && e.shiftKey && e.code === 'KeyP') return false
      if ((e.ctrlKey || e.metaKey) && e.shiftKey && e.code === 'KeyA') return false
      if ((e.ctrlKey || e.metaKey) && e.shiftKey && e.code === 'KeyD') return false
      if (e.type !== 'keydown') return true
      // Atajos estándar de terminal: Ctrl+Shift+C/V (Ctrl+C solo sigue siendo SIGINT).
      // preventDefault es clave: Chromium también trae Ctrl+Shift+V nativo
      // (pegar sin formato) y sin cancelarlo el texto se pegaba DOBLE.
      if (e.ctrlKey && e.shiftKey && !e.altKey && e.code === 'KeyC') {
        e.preventDefault()
        copySelection()
        return false
      }
      if (e.ctrlKey && e.shiftKey && !e.altKey && e.code === 'KeyV') {
        e.preventDefault()
        pasteClipboard()
        return false
      }
      // Ctrl+C a secas: copia SOLO si hay selección, y la limpia al copiar; sin
      // selección sigue siendo SIGINT. Así cancelar un turno nunca se pierde: el
      // segundo Ctrl+C ya corta, porque el primero dejó la selección vacía. Es lo
      // que hacen GNOME Terminal y Windows Terminal.
      // El criterio es SOLO term.hasSelection(): mirar también window.getSelection()
      // rompía el SIGINT, porque xterm deja texto seleccionado en su textarea
      // interno y entonces Ctrl+C interceptaba siempre y no cortaba nunca.
      if (e.ctrlKey && !e.shiftKey && !e.altKey && e.code === 'KeyC' && term.hasSelection()) {
        e.preventDefault()
        alPortapapeles(term.getSelection(), '')
        term.clearSelection()
        return false
      }
      // Ctrl+V pega. El costo asumido es el quoted-insert de readline (Ctrl+V ya
      // no inserta el siguiente carácter literal) y el bloque visual de vim, que
      // en estas terminales no se usan.
      if (e.ctrlKey && !e.shiftKey && !e.altKey && e.code === 'KeyV') {
        e.preventDefault()
        pasteClipboard()
        return false
      }
      // Ctrl+Insert / Shift+Insert: el otro par estándar de XTerm. Sirve de
      // salida cuando algo fuera de la app (IME, atajo del escritorio, layout)
      // se come el Ctrl+Shift+letra antes de que Chromium lo vea.
      if (e.ctrlKey && !e.shiftKey && !e.altKey && e.code === 'Insert') {
        e.preventDefault()
        copySelection()
        return false
      }
      if (e.shiftKey && !e.ctrlKey && !e.altKey && e.code === 'Insert') {
        e.preventDefault()
        pasteClipboard()
        return false
      }
      // macOS: Cmd+C copia si hay selección (sin selección pasa al TUI), Cmd+V pega
      if (e.metaKey && !e.ctrlKey && e.code === 'KeyC' && term.hasSelection()) {
        e.preventDefault()
        copySelection()
        return false
      }
      if (e.metaKey && !e.ctrlKey && e.code === 'KeyV') {
        e.preventDefault()
        pasteClipboard()
        return false
      }
      return true
    })

    const fit = new FitAddon()
    term.loadAddon(fit)
    term.loadAddon(new WebLinksAddon((_event, uri) => window.open(uri)))
    term.open(el)
    fit.fit()
    termRef.current = term

    let disposed = false
    const cleanups: Array<() => void> = []

    // Monitor de actividad: solo la salida SOSTENIDA (≥1.5s, como el spinner de
    // un agente pensando o un build) cuenta como "trabajando"; al callarse
    // ~2.5s → aviso si la celda no está activa. Las ráfagas cortas (banner de
    // arranque, repintado del TUI al cambiar el foco) no disparan nada — si
    // contaran, cada cambio de foco terminaría en una falsa alerta de atención.
    let lastOutput = 0
    let burstStart = 0
    let working = false
    window.bridge.createPty({
      id: ptyId,
      cellId,
      cwd,
      command,
      perm,
      resumeSession,
      cols: term.cols,
      rows: term.rows
    })
      .then(() => {
        if (disposed) {
          window.bridge.kill(ptyId)
          return
        }
        cleanups.push(
          window.bridge.onData(ptyId, (data) => {
            term.write(data)
            const now = Date.now()
            if (now - lastOutput > 2500) burstStart = now
            lastOutput = now
            if (!working && now - burstStart >= 1500) {
              working = true
              cbRef.current.onActivity('working')
            }
          })
        )
        cleanups.push(window.bridge.onExit(ptyId, (code) => cbRef.current.onExit(code)))
        cleanups.push(window.bridge.onPtySession(ptyId, (sid) => cbRef.current.onSession(sid)))
      })

    const quietTimer = window.setInterval(() => {
      if (working && Date.now() - lastOutput > 2500) {
        working = false
        cbRef.current.onActivity('idle')
        if (!activeRef.current) cbRef.current.onAttention()
      }
    }, 600)

    // Campana (BEL): Claude Code la usa para pedir atención (permisos, etc.).
    const bellDisp = term.onBell(() => {
      if (!activeRef.current) cbRef.current.onAttention()
    })

    // Título OSC 0/2: los agentes anuncian ahí en qué están trabajando. Los
    // títulos que solo repiten el shell o el cwd se descartan (cleanTerminal-
    // Title devuelve null) y la celda conserva el último título con sentido.
    const titleDisp = term.onTitleChange((raw) => {
      const clean = cleanTerminalTitle(raw, cwd)
      if (clean) cbRef.current.onAutoTitle(clean)
    })

    const inputDisp = term.onData((data) => {
      window.bridge.write(ptyId, data)
      cbRef.current.onUserInput()
    })

    // Ctrl+clic sobre rutas de archivo en la salida → abrir en una celda visor.
    const linkDisp = term.registerLinkProvider({
      provideLinks(y, callback) {
        const line = term.buffer.active.getLine(y - 1)
        if (!line) return callback(undefined)
        const text = line.translateToString(true)
        const candidates: Array<{ idx: number; raw: string; clean: string }> = []
        PATH_RE.lastIndex = 0
        let m: RegExpExecArray | null
        while ((m = PATH_RE.exec(text))) {
          const before = text.slice(Math.max(0, m.index - 8), m.index)
          if (before.includes('://')) continue // las URLs son del WebLinksAddon
          const clean = m[0].replace(/:\d+(?::\d+)?$/, '').replace(/[)\],.;:'"]+$/, '')
          if (clean.length < 3) continue
          candidates.push({ idx: m.index, raw: m[0], clean })
        }
        if (candidates.length === 0) return callback(undefined)
        Promise.all(
          candidates.map(async (c) => {
            const resolved = await window.bridge.resolveExisting(c.clean, cwd)
            if (!resolved) return null
            const link: ILink = {
              range: { start: { x: c.idx + 1, y }, end: { x: c.idx + c.raw.length, y } },
              text: c.raw,
              activate: (event) => {
                if (event.ctrlKey || event.metaKey) cbRef.current.onOpenFile(resolved)
              }
            }
            return link
          })
        ).then((links) => callback(links.filter((l): l is ILink => l !== null)))
      }
    })

    // OSC 52: la secuencia con la que un TUI copia al portapapeles del sistema.
    // Claude Code la usa cuando seleccionás dentro de su propia UI (avisa "sent N
    // chars via OSC 52") y xterm no la trae implementada, así que sin esto el
    // copiado del agente se descartaba en silencio y al pegar salía lo anterior.
    const oscDisp = term.parser.registerOscHandler(52, (data) => {
      const sep = data.indexOf(';')
      if (sep === -1) return true
      const destinos = data.slice(0, sep)
      const carga = data.slice(sep + 1)
      // '?' es una LECTURA del portapapeles: no se responde a propósito, para no
      // dejar que un agente se lleve lo que tengas copiado.
      if (carga === '?') return true
      let texto: string
      try {
        const bin = atob(carga)
        texto = new TextDecoder().decode(Uint8Array.from(bin, (c) => c.charCodeAt(0)))
      } catch {
        return true
      }
      if (!texto) return true
      // Destino vacío = portapapeles, según la convención de xterm.
      if (destinos === '' || destinos.includes('c')) window.bridge.writeClipboard(texto)
      if (destinos.includes('p') || destinos.includes('s')) window.bridge.writePrimary(texto)
      showFlash(`✓ copiado por el agente · ${texto.length} caracteres`)
      return true
    })

    // Selección con mouse → portapapeles primario (solo Linux), como toda terminal.
    const selDisp = term.onSelectionChange(() => {
      if (window.bridge.platform === 'linux' && term.hasSelection()) {
        window.bridge.writePrimary(term.getSelection())
      }
    })

    // Clic del medio → pegar desde el primario, salvo que el TUI capture el mouse.
    const onAuxClick = (e: MouseEvent): void => {
      if (e.button !== 1 || window.bridge.platform !== 'linux') return
      if (term.modes.mouseTrackingMode !== 'none') return
      e.preventDefault()
      const text = window.bridge.readPrimary()
      if (text) term.paste(text)
    }
    el.addEventListener('auxclick', onAuxClick)

    const onContextMenu = async (e: MouseEvent): Promise<void> => {
      e.preventDefault()
      const action = await window.bridge.termMenu(term.hasSelection())
      switch (action) {
        case 'copy':
          copySelection()
          break
        case 'paste':
          pasteClipboard()
          break
        case 'selectAll':
          term.selectAll()
          break
        case 'clear':
          term.clear()
          break
      }
    }
    el.addEventListener('contextmenu', onContextMenu)

    const ro = new ResizeObserver(() => {
      fit.fit()
      window.bridge.resize(ptyId, term.cols, term.rows)
    })
    ro.observe(el)

    term.focus()

    return () => {
      disposed = true
      ro.disconnect()
      window.clearInterval(quietTimer)
      el.removeEventListener('auxclick', onAuxClick)
      el.removeEventListener('contextmenu', onContextMenu)
      linkDisp.dispose()
      oscDisp.dispose()
      bellDisp.dispose()
      titleDisp.dispose()
      selDisp.dispose()
      inputDisp.dispose()
      cleanups.forEach((off) => off())
      window.bridge.kill(ptyId)
      // xterm escribe en un <textarea> oculto: destruirlo mientras tiene el
      // foco deja al IME de Linux con la composición colgada (traga espacios y
      // mayúsculas). Con blur primero, el foco se libera en orden.
      const focused = document.activeElement
      if (focused instanceof HTMLElement && el.contains(focused)) focused.blur()
      term.dispose()
      termRef.current = null
    }
  }, [ptyId, command, cwd, perm, resumeSession])

  // Ctrl+Shift+A/D desde App: pegar la ruta elegida en esta terminal.
  useEffect(() => {
    const onInsert = (e: Event): void => {
      const detail = (e as CustomEvent).detail as { cellId: string; text: string }
      if (detail.cellId !== cellId) return
      termRef.current?.paste(detail.text)
      termRef.current?.focus()
    }
    window.addEventListener('bridge:insert-path', onInsert)
    return () => window.removeEventListener('bridge:insert-path', onInsert)
  }, [cellId])

  useEffect(() => {
    if (active) termRef.current?.focus()
  }, [active])

  // Reclamar el teclado cuando otra celda se cierra (ver App.closeCell).
  useFocusOnRequest(cellId, () => termRef.current?.focus())

  const [dragOver, setDragOver] = useState(false)

  useEffect(() => () => window.clearTimeout(flashTimerRef.current), [])

  return (
    <>
      <div
        ref={containerRef}
        className={`term-container ${dragOver ? 'drop-target' : ''}`}
        onDragOver={(e) => {
          // el drag de celdas pasa de largo hacia el grid-item (intercambio)
          if (e.dataTransfer.types.includes(CELL_MIME)) return
          e.preventDefault()
          e.dataTransfer.dropEffect = 'copy'
          setDragOver(true)
        }}
        onDragLeave={() => setDragOver(false)}
        onDrop={(e) => {
          if (e.dataTransfer.types.includes(CELL_MIME)) return
          e.preventDefault()
          setDragOver(false)
          const paths = pathsFromDrop(e.dataTransfer)
          if (paths.length === 0) return
          termRef.current?.paste(quotePaths(paths))
          termRef.current?.focus()
        }}
      />
      {flash && <div className="term-flash">{flash}</div>}
    </>
  )
}
