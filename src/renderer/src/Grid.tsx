import { useEffect, useState, type CSSProperties } from 'react'
import type { CellState } from './App'
import { TerminalCell } from './TerminalCell'
import { CELL_MIME } from './dnd'

// Orientación de la VENTANA (no del monitor): si la ventana queda más alta
// que ancha (monitor vertical, o media pantalla en uno horizontal), la grilla
// se voltea para que las celdas conserven ancho útil.
function useIsPortrait(): boolean {
  const [portrait, setPortrait] = useState(
    () => window.matchMedia('(orientation: portrait)').matches
  )
  useEffect(() => {
    const mq = window.matchMedia('(orientation: portrait)')
    const onChange = (e: MediaQueryListEvent): void => setPortrait(e.matches)
    mq.addEventListener('change', onChange)
    return () => mq.removeEventListener('change', onChange)
  }, [])
  return portrait
}

interface GridProps {
  cells: CellState[]
  activeId: string | null
  onActivate: (id: string) => void
  onClose: (id: string) => void
  onUpdate: (id: string, patch: Partial<CellState>) => void
  onOpenFile: (path: string) => void
  onSwap: (idA: string, idB: string) => void
}

/**
 * Layout dinámico según cuántas celdas hay.
 * Horizontal: 1 → 1×1   2 → 2 columnas   3 → 3 columnas
 *             4 → 2×2   5 → 3 arriba + 2 abajo   6 → 3×2
 * Vertical (ventana más alta que ancha) — el espejo, en filas:
 *             2 → 2 filas   3 → 3 filas
 *             4 → 2×2   5 → 3 a la izquierda + 2 a la derecha   6 → 2×3
 */
function gridStyle(n: number, portrait: boolean): CSSProperties {
  if (portrait) {
    switch (n) {
      case 1:
        return { gridTemplateColumns: '1fr', gridTemplateRows: '1fr' }
      case 2:
        return { gridTemplateColumns: '1fr', gridTemplateRows: 'repeat(2, 1fr)' }
      case 3:
        return { gridTemplateColumns: '1fr', gridTemplateRows: 'repeat(3, 1fr)' }
      case 4:
        return { gridTemplateColumns: 'repeat(2, 1fr)', gridTemplateRows: 'repeat(2, 1fr)' }
      case 5:
        // Grilla base de 6 filas en 2 columnas, llenando por columnas:
        // 3 celdas de span 2 a la izquierda, 2 de span 3 a la derecha.
        return {
          gridTemplateColumns: 'repeat(2, 1fr)',
          gridTemplateRows: 'repeat(6, 1fr)',
          gridAutoFlow: 'column'
        }
      default:
        return {
          gridTemplateColumns: 'repeat(2, 1fr)',
          gridTemplateRows: 'repeat(3, 1fr)',
          gridAutoFlow: 'column'
        }
    }
  }
  switch (n) {
    case 1:
      return { gridTemplateColumns: '1fr', gridTemplateRows: '1fr' }
    case 2:
      return { gridTemplateColumns: 'repeat(2, 1fr)', gridTemplateRows: '1fr' }
    case 3:
      return { gridTemplateColumns: 'repeat(3, 1fr)', gridTemplateRows: '1fr' }
    case 4:
      return { gridTemplateColumns: 'repeat(2, 1fr)', gridTemplateRows: 'repeat(2, 1fr)' }
    case 5:
      // Grilla base de 6 columnas: 3 celdas de span 2 arriba, 2 de span 3 abajo.
      return { gridTemplateColumns: 'repeat(6, 1fr)', gridTemplateRows: 'repeat(2, 1fr)' }
    default:
      return { gridTemplateColumns: 'repeat(3, 1fr)', gridTemplateRows: 'repeat(2, 1fr)' }
  }
}

function itemStyle(n: number, index: number, portrait: boolean): CSSProperties | undefined {
  if (n !== 5) return undefined
  if (portrait) return { gridRow: index < 3 ? 'span 2' : 'span 3' }
  return { gridColumn: index < 3 ? 'span 2' : 'span 3' }
}

export function Grid({
  cells,
  activeId,
  onActivate,
  onClose,
  onUpdate,
  onOpenFile,
  onSwap
}: GridProps): JSX.Element {
  const n = cells.length
  const portrait = useIsPortrait()
  const [dropTargetId, setDropTargetId] = useState<string | null>(null)

  return (
    <div className="grid" style={gridStyle(n, portrait)}>
      {cells.map((cell, i) => (
        <div
          key={cell.id}
          className={`grid-item ${dropTargetId === cell.id ? 'grid-item-drop' : ''}`}
          style={itemStyle(n, i, portrait)}
          onDragOver={(e) => {
            if (!e.dataTransfer.types.includes(CELL_MIME)) return
            e.preventDefault()
            e.dataTransfer.dropEffect = 'move'
            setDropTargetId(cell.id)
          }}
          onDragLeave={() => setDropTargetId((cur) => (cur === cell.id ? null : cur))}
          onDrop={(e) => {
            setDropTargetId(null)
            const sourceId = e.dataTransfer.getData(CELL_MIME)
            if (!sourceId || sourceId === cell.id) return
            e.preventDefault()
            onSwap(sourceId, cell.id)
          }}
        >
          <TerminalCell
            cell={cell}
            index={i}
            active={cell.id === activeId}
            onActivate={onActivate}
            onClose={onClose}
            onUpdate={onUpdate}
            onOpenFile={onOpenFile}
          />
        </div>
      ))}
    </div>
  )
}
