import { useEffect, useRef, useState } from 'react'

export interface PaletteCommand {
  id: string
  label: string
  hint?: string
  run: () => void
}

interface PaletteProps {
  commands: PaletteCommand[]
  onClose: () => void
}

export function Palette({ commands, onClose }: PaletteProps): JSX.Element {
  const [query, setQuery] = useState('')
  const [sel, setSel] = useState(0)
  const inputRef = useRef<HTMLInputElement>(null)

  const q = query.trim().toLowerCase()
  const filtered = q ? commands.filter((c) => c.label.toLowerCase().includes(q)) : commands
  const selected = Math.min(sel, Math.max(0, filtered.length - 1))

  useEffect(() => {
    inputRef.current?.focus()
  }, [])

  const runCommand = (cmd?: PaletteCommand): void => {
    onClose()
    cmd?.run()
  }

  return (
    <div
      className="palette-overlay"
      onMouseDown={(e) => {
        if (e.target === e.currentTarget) onClose()
      }}
    >
      <div className="palette">
        <input
          ref={inputRef}
          value={query}
          placeholder="Escribe un comando…"
          spellCheck={false}
          onChange={(e) => {
            setQuery(e.target.value)
            setSel(0)
          }}
          onKeyDown={(e) => {
            if (e.key === 'Escape') onClose()
            else if (e.key === 'ArrowDown') {
              e.preventDefault()
              setSel((s) => Math.min(s + 1, filtered.length - 1))
            } else if (e.key === 'ArrowUp') {
              e.preventDefault()
              setSel((s) => Math.max(s - 1, 0))
            } else if (e.key === 'Enter') {
              runCommand(filtered[selected])
            }
          }}
        />
        <ul className="palette-list">
          {filtered.map((c, i) => (
            <li
              key={c.id}
              className={i === selected ? 'palette-selected' : ''}
              onMouseEnter={() => setSel(i)}
              onMouseDown={(e) => {
                e.preventDefault()
                runCommand(c)
              }}
            >
              <span>{c.label}</span>
              {c.hint && <span className="palette-hint">{c.hint}</span>}
            </li>
          ))}
          {filtered.length === 0 && <li className="palette-empty">Sin resultados</li>}
        </ul>
      </div>
    </div>
  )
}
