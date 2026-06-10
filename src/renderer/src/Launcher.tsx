import { useEffect, useState } from 'react'
import type { AgentKind } from './App'

interface LauncherProps {
  onStart: (kind: AgentKind, cwd: string, mode: 'term' | 'chat') => void
  onOpenFile: (path: string) => void
}

export function Launcher({ onStart, onOpenFile }: LauncherProps): JSX.Element {
  const [cwd, setCwd] = useState('')

  useEffect(() => {
    window.bridge.homeDir().then((home) => setCwd((current) => current || home))
  }, [])

  const pick = async (): Promise<void> => {
    const dir = await window.bridge.pickDirectory()
    if (dir) setCwd(dir)
  }

  const start = (kind: AgentKind, mode: 'term' | 'chat' = 'term'): void => {
    if (cwd.trim()) onStart(kind, cwd.trim(), mode)
  }

  return (
    <div className="launcher">
      <h2>¿Qué corre en esta celda?</h2>
      <div className="cwd-row">
        <input
          value={cwd}
          onChange={(e) => setCwd(e.target.value)}
          placeholder="Directorio de trabajo"
          spellCheck={false}
        />
        <button onClick={pick} title="Examinar…">
          📁
        </button>
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
