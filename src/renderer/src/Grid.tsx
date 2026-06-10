import type { CSSProperties } from 'react'
import type { CellState } from './App'
import { TerminalCell } from './TerminalCell'

interface GridProps {
  cells: CellState[]
  activeId: string | null
  onActivate: (id: string) => void
  onClose: (id: string) => void
  onUpdate: (id: string, patch: Partial<CellState>) => void
  onOpenFile: (path: string) => void
}

/**
 * Layout dinámico según cuántas celdas hay:
 *  1 → 1×1   2 → 2 columnas   3 → 3 columnas
 *  4 → 2×2   5 → 3 arriba + 2 abajo   6 → 3×2
 */
function gridStyle(n: number): CSSProperties {
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

function itemStyle(n: number, index: number): CSSProperties | undefined {
  if (n !== 5) return undefined
  return { gridColumn: index < 3 ? 'span 2' : 'span 3' }
}

export function Grid({
  cells,
  activeId,
  onActivate,
  onClose,
  onUpdate,
  onOpenFile
}: GridProps): JSX.Element {
  const n = cells.length
  return (
    <div className="grid" style={gridStyle(n)}>
      {cells.map((cell, i) => (
        <div key={cell.id} className="grid-item" style={itemStyle(n, i)}>
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
