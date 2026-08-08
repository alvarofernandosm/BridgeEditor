import { useEffect, useRef, useState } from 'react'
import type { AgentKind, PermLevel } from './App'
import { useFocusOnRequest } from './focus'

interface LauncherProps {
  cellId: string
  onStart: (kind: AgentKind, cwd: string, mode: 'term' | 'chat', perm: PermLevel) => void
  onOpenFile: (path: string) => void
}

export function Launcher({ cellId, onStart, onOpenFile }: LauncherProps): JSX.Element {
  const [cwd, setCwd] = useState('')
  const [perm, setPerm] = useState<PermLevel>('default')
  const cwdRef = useRef<HTMLInputElement>(null)

  // Al cerrar la celda vecina el teclado viene a parar aquí: sin esto se
  // quedaba en <body> y la celda, aun siendo la activa, no respondía.
  useFocusOnRequest(cellId, () => cwdRef.current?.focus())

  useEffect(() => {
    window.bridge.homeDir().then((home) => setCwd((current) => current || home))
  }, [])

  const pick = async (): Promise<void> => {
    const dir = await window.bridge.pickDirectory()
    if (dir) setCwd(dir)
  }

  const start = (kind: AgentKind, mode: 'term' | 'chat' = 'term'): void => {
    if (cwd.trim()) onStart(kind, cwd.trim(), mode, perm)
  }

  return (
    <div className="launcher">
      <h2>¿Qué corre en esta celda?</h2>
      <div className="cwd-row">
        <input
          ref={cwdRef}
          value={cwd}
          onChange={(e) => setCwd(e.target.value)}
          placeholder="Directorio de trabajo"
          spellCheck={false}
        />
        <button onClick={pick} title="Examinar…">
          📁
        </button>
      </div>
      <div className="perm-row">
        <span>Permisos del agente</span>
        <select value={perm} onChange={(e) => setPerm(e.target.value as PermLevel)}>
          <option value="default">preguntar todo (default)</option>
          <option value="flexible">flexible — solo pregunta lo crítico</option>
          <option value="yolo">sin preguntar nada (⚠ riesgoso)</option>
        </select>
      </div>
      <div className="launcher-group">
        <span className="launcher-label">Terminal</span>
        <div className="agent-buttons">
          <button className="agent-btn claude" onClick={() => start('claude')}>
            ✳ Claude Code
          </button>
          <button className="agent-btn opencode" onClick={() => start('opencode')}>
            ⌬ OpenCode
          </button>
          <button className="agent-btn antigravity" onClick={() => start('antigravity')}>
            ☄ Antigravity
          </button>
          <button className="agent-btn shell" onClick={() => start('shell')}>
            $ Shell
          </button>
        </div>
      </div>
      <div className="launcher-group">
        <span className="launcher-label">Chat agéntico</span>
        <div className="agent-buttons">
          <button className="agent-btn claude" onClick={() => start('claude', 'chat')}>
            💬 Claude Code
          </button>
          <button className="agent-btn opencode" onClick={() => start('opencode', 'chat')}>
            💬 OpenCode
          </button>
          <button className="agent-btn antigravity" onClick={() => start('antigravity', 'chat')}>
            💬 Antigravity
          </button>
        </div>
      </div>
      <div className="launcher-group">
        <span className="launcher-label">Archivos</span>
        <div className="agent-buttons">
          <button
            className="agent-btn file"
            onClick={async () => {
              const path = await window.bridge.pickFile()
              if (path) onOpenFile(path)
            }}
          >
            📄 Abrir archivo
          </button>
        </div>
      </div>
    </div>
  )
}
