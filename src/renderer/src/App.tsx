import { useCallback, useEffect, useState } from 'react'
import { Grid } from './Grid'
import { Palette, type PaletteCommand } from './Palette'
import { AGENTS } from './TerminalCell'

export type AgentKind = 'claude' | 'opencode' | 'shell'
export type PermLevel = 'default' | 'flexible' | 'yolo'

export interface CellState {
  id: string
  agent: AgentKind | null
  /** 'term' = TUI en PTY; 'chat' = interfaz de chat sobre el modo headless. */
  mode: 'term' | 'chat'
  /** Nivel de permisos con el que se lanza el agente de esta celda. */
  perm: PermLevel
  /** true cuando la celda viene de una restauración: claude se relanza con --resume. */
  resume: boolean
  /** Session id de claude detectado para esta celda de terminal (para el resume exacto). */
  termSessionId: string | null
  /** Sesión de claude para --resume entre turnos (y entre reinicios). */
  chatSessionId: string | null
  /** Ruta del archivo abierto cuando la celda es un visor (status 'file'). */
  file: string | null
  cwd: string
  status: 'launcher' | 'running' | 'exited' | 'file'
  exitCode?: number
  /** Se incrementa para relanzar: fuerza un PTY y un xterm nuevos. */
  generation: number
  /** 'working' = hay salida reciente; 'idle' = la terminal está quieta. */
  activity: 'working' | 'idle'
  /** El agente quedó esperando (silencio o campana) sin que la celda esté activa. */
  attention: boolean
}

export const MAX_CELLS = 6

let nextId = 1
const newCell = (): CellState => ({
  id: `cell-${nextId++}`,
  agent: null,
  mode: 'term',
  perm: 'default',
  resume: false,
  termSessionId: null,
  chatSessionId: null,
  file: null,
  cwd: '',
  status: 'launcher',
  generation: 0,
  activity: 'idle',
  attention: false
})

const STORAGE_KEY = 'bridge-editor.layout.v1'
const AGENT_KINDS: AgentKind[] = ['claude', 'opencode', 'shell']

interface SavedCell {
  agent: AgentKind | null
  mode?: 'term' | 'chat'
  perm?: PermLevel
  termSessionId?: string | null
  chatSessionId?: string | null
  file: string | null
  cwd: string
}

// Restaura el layout de la sesión anterior: las celdas de archivo se reabren
// y las de agente relanzan su comando en el mismo directorio.
function loadSavedLayout(): CellState[] | null {
  try {
    const raw = localStorage.getItem(STORAGE_KEY)
    if (!raw) return null
    const saved = JSON.parse(raw) as SavedCell[]
    if (!Array.isArray(saved) || saved.length === 0) return null
    return saved.slice(0, MAX_CELLS).map((s) => {
      const agent = AGENT_KINDS.includes(s.agent as AgentKind) ? (s.agent as AgentKind) : null
      const file = typeof s.file === 'string' ? s.file : null
      return {
        id: `cell-${nextId++}`,
        agent,
        mode: s.mode === 'chat' && agent !== 'shell' ? 'chat' : 'term',
        perm: s.perm === 'flexible' || s.perm === 'yolo' ? s.perm : 'default',
        // las terminales de claude restauradas retoman SU conversación (--resume id)
        resume: agent !== null && agent !== 'shell' && s.mode !== 'chat',
        termSessionId: typeof s.termSessionId === 'string' ? s.termSessionId : null,
        chatSessionId: typeof s.chatSessionId === 'string' ? s.chatSessionId : null,
        file,
        cwd: typeof s.cwd === 'string' ? s.cwd : '',
        status: file ? 'file' : agent ? 'running' : 'launcher',
        generation: 0,
        activity: 'idle',
        attention: false
      } satisfies CellState
    })
  } catch {
    return null
  }
}

const labelOf = (c: CellState): string =>
  c.status === 'file' && c.file
    ? `📄 ${c.file.split(/[\\/]/).pop()}`
    : c.agent
      ? `${c.mode === 'chat' ? '💬 ' : ''}${AGENTS[c.agent].label}`
      : 'launcher'

export default function App(): JSX.Element {
  const [cells, setCells] = useState<CellState[]>(() => loadSavedLayout() ?? [newCell()])
  const [activeId, setActiveId] = useState<string | null>(null)
  const [paletteOpen, setPaletteOpen] = useState(false)
  const [home, setHome] = useState('')

  useEffect(() => {
    window.bridge.homeDir().then(setHome)
  }, [])

  // Sin esto, soltar un archivo fuera de una zona de drop navegaría a file://
  useEffect(() => {
    const prevent = (e: DragEvent): void => e.preventDefault()
    window.addEventListener('dragover', prevent)
    window.addEventListener('drop', prevent)
    return () => {
      window.removeEventListener('dragover', prevent)
      window.removeEventListener('drop', prevent)
    }
  }, [])

  useEffect(() => {
    const snapshot: SavedCell[] = cells.map((c) => ({
      agent: c.agent,
      mode: c.mode,
      perm: c.perm,
      termSessionId: c.termSessionId,
      chatSessionId: c.chatSessionId,
      file: c.file,
      cwd: c.cwd
    }))
    localStorage.setItem(STORAGE_KEY, JSON.stringify(snapshot))
  }, [cells])

  const addCell = useCallback(() => {
    setCells((cs) => (cs.length >= MAX_CELLS ? cs : [...cs, newCell()]))
  }, [])

  const closeCell = useCallback((id: string) => {
    // El kill del PTY ocurre en el desmontaje de TerminalView.
    setCells((cs) => {
      const next = cs.filter((c) => c.id !== id)
      return next.length === 0 ? [newCell()] : next
    })
  }, [])

  const updateCell = useCallback((id: string, patch: Partial<CellState>) => {
    setCells((cs) => cs.map((c) => (c.id === id ? { ...c, ...patch } : c)))
  }, [])

  // Activar una celda apaga su aviso de atención.
  const activateCell = useCallback((id: string) => {
    setActiveId(id)
    setCells((cs) => cs.map((c) => (c.id === id && c.attention ? { ...c, attention: false } : c)))
  }, [])

  // Ctrl+clic en una ruta de la terminal: reusar la celda que ya muestra ese
  // archivo, abrir una celda nueva si hay espacio, o reciclar el primer visor.
  const openFileInCell = useCallback((path: string) => {
    setCells((cs) => {
      const existing = cs.find((c) => c.status === 'file' && c.file === path)
      if (existing) return cs
      if (cs.length < MAX_CELLS) return [...cs, { ...newCell(), status: 'file' as const, file: path }]
      const viewer = cs.find((c) => c.status === 'file')
      if (viewer) return cs.map((c) => (c.id === viewer.id ? { ...c, file: path } : c))
      return cs
    })
  }, [])

  const launchInNewCell = useCallback((kind: AgentKind, cwd: string, mode: 'term' | 'chat') => {
    setCells((cs) =>
      cs.length >= MAX_CELLS
        ? cs
        : [...cs, { ...newCell(), agent: kind, cwd, mode, status: 'running' as const }]
    )
  }, [])

  // Drag & drop de headers: intercambia la posición de dos celdas.
  const swapCells = useCallback((idA: string, idB: string) => {
    setCells((cs) => {
      const ia = cs.findIndex((c) => c.id === idA)
      const ib = cs.findIndex((c) => c.id === idB)
      if (ia < 0 || ib < 0 || ia === ib) return cs
      const next = [...cs]
      ;[next[ia], next[ib]] = [next[ib], next[ia]]
      return next
    })
  }, [])

  // Ctrl+Shift+A / Ctrl+Shift+D: elegir archivo/directorio y pegar su ruta
  // (entre comillas si hace falta) en la terminal o el chat de la celda activa.
  // Se usan combos con Shift porque los TUI no los distinguen de Ctrl+letra:
  // los interceptamos nosotros y Ctrl+O/A/D simples siguen llegando al agente.
  const insertPathIntoActive = useCallback(
    async (kind: 'file' | 'dir') => {
      if (!activeId) return
      const path =
        kind === 'file' ? await window.bridge.pickFile() : await window.bridge.pickDirectory()
      if (!path) return
      const quoted = /[^\w@%+=:,./-]/.test(path) ? `'${path.replace(/'/g, "'\\''")}'` : path
      window.dispatchEvent(
        new CustomEvent('bridge:insert-path', { detail: { cellId: activeId, text: quoted } })
      )
    },
    [activeId]
  )

  useEffect(() => {
    const onKey = (e: KeyboardEvent): void => {
      if ((e.ctrlKey || e.metaKey) && e.shiftKey && !e.altKey && e.code === 'KeyA') {
        e.preventDefault()
        insertPathIntoActive('file')
        return
      }
      if ((e.ctrlKey || e.metaKey) && e.shiftKey && !e.altKey && e.code === 'KeyD') {
        e.preventDefault()
        insertPathIntoActive('dir')
        return
      }
      if ((e.ctrlKey || e.metaKey) && e.shiftKey && !e.altKey && e.code === 'KeyP') {
        e.preventDefault()
        setPaletteOpen((open) => !open)
        return
      }
      // Ctrl+K también abre la paleta, pero no dentro de una terminal
      // (ahí es "matar hasta fin de línea" en el shell).
      const inTerminal = (document.activeElement as HTMLElement | null)?.classList.contains(
        'xterm-helper-textarea'
      )
      if ((e.ctrlKey || e.metaKey) && !e.shiftKey && e.key.toLowerCase() === 'k' && !inTerminal) {
        e.preventDefault()
        setPaletteOpen((open) => !open)
        return
      }
      if ((e.ctrlKey || e.metaKey) && !e.shiftKey && !e.altKey) {
        const n = Number(e.key)
        if (n >= 1 && n <= cells.length) {
          e.preventDefault()
          activateCell(cells[n - 1].id)
        }
      }
    }
    window.addEventListener('keydown', onKey, true)
    return () => window.removeEventListener('keydown', onKey, true)
  }, [cells, activateCell, insertPathIntoActive])

  const activeCell = cells.find((c) => c.id === activeId) ?? null
  const paletteCommands: PaletteCommand[] = []
  if (cells.length < MAX_CELLS) {
    const baseCwd = activeCell?.cwd || home
    AGENT_KINDS.forEach((kind) => {
      paletteCommands.push({
        id: `new-${kind}`,
        label: `Lanzar ${AGENTS[kind].label} en nueva celda`,
        hint: baseCwd,
        run: () => launchInNewCell(kind, baseCwd, 'term')
      })
    })
    ;(['claude', 'opencode'] as AgentKind[]).forEach((kind) => {
      paletteCommands.push({
        id: `chat-${kind}`,
        label: `💬 Chat con ${AGENTS[kind].label} en nueva celda`,
        hint: baseCwd,
        run: () => launchInNewCell(kind, baseCwd, 'chat')
      })
    })
    paletteCommands.push({ id: 'new-empty', label: 'Nueva celda vacía (launcher)', run: addCell })
  }
  paletteCommands.push({
    id: 'open-file',
    label: 'Abrir archivo en celda visor…',
    run: () => {
      window.bridge.pickFile().then((path) => path && openFileInCell(path))
    }
  })
  if (activeCell) {
    paletteCommands.push({
      id: 'close-active',
      label: `Cerrar celda activa (${labelOf(activeCell)})`,
      run: () => closeCell(activeCell.id)
    })
    if (activeCell.status === 'exited') {
      paletteCommands.push({
        id: 'relaunch-active',
        label: 'Relanzar agente de la celda activa',
        run: () =>
          updateCell(activeCell.id, { status: 'running', generation: activeCell.generation + 1 })
      })
    }
  }
  if (activeCell?.status === 'running') {
    paletteCommands.push({
      id: 'insert-file',
      label: 'Insertar ruta de archivo en la celda activa…',
      hint: 'Ctrl+Shift+A',
      run: () => insertPathIntoActive('file')
    })
    paletteCommands.push({
      id: 'insert-dir',
      label: 'Insertar ruta de carpeta en la celda activa…',
      hint: 'Ctrl+Shift+D',
      run: () => insertPathIntoActive('dir')
    })
  }
  cells.forEach((c, i) => {
    paletteCommands.push({
      id: `go-${c.id}`,
      label: `Ir a celda ${i + 1} — ${labelOf(c)}`,
      hint: `Ctrl+${i + 1}`,
      run: () => activateCell(c.id)
    })
  })

  return (
    <div className="app">
      <header className="topbar">
        <div className="brand">
          Bridge<span>Editor</span>
        </div>
        <span className="hint">Ctrl+1…6 celdas · Ctrl+Shift+P paleta</span>
        <div className="spacer" />
        <span className="hint">
          {cells.length}/{MAX_CELLS}
        </span>
        <button
          className="add-btn"
          onClick={addCell}
          disabled={cells.length >= MAX_CELLS}
          title="Agregar una celda (la grilla se divide sola)"
        >
          + Nueva celda
        </button>
      </header>
      <Grid
        cells={cells}
        activeId={activeId}
        onActivate={activateCell}
        onClose={closeCell}
        onUpdate={updateCell}
        onOpenFile={openFileInCell}
        onSwap={swapCells}
      />
      {paletteOpen && <Palette commands={paletteCommands} onClose={() => setPaletteOpen(false)} />}
    </div>
  )
}
