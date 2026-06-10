import { ipcMain } from 'electron'
import * as pty from 'node-pty'

const sessions = new Map<string, pty.IPty>()

function defaultShell(): string {
  if (process.platform === 'win32') return 'powershell.exe'
  return process.env.SHELL || '/bin/bash'
}

export function registerPtyHandlers(): void {
  ipcMain.handle(
    'pty:create',
    (
      event,
      opts: { id: string; cwd: string; command: string | null; cols: number; rows: number }
    ) => {
      const { id, cwd, command, cols, rows } = opts
      const wc = event.sender
      const shellPath = defaultShell()
      // Shell de login: hereda el PATH del usuario (nvm, ~/.local/bin, etc.),
      // que es donde suelen vivir claude y opencode.
      const args = process.platform === 'win32' ? [] : ['-l']

      const proc = pty.spawn(shellPath, args, {
        name: 'xterm-256color',
        cols: Math.max(cols, 2),
        rows: Math.max(rows, 1),
        cwd,
        env: {
          ...process.env,
          TERM: 'xterm-256color',
          COLORTERM: 'truecolor'
        } as Record<string, string>
      })
      sessions.set(id, proc)

      proc.onData((data) => {
        if (!wc.isDestroyed()) wc.send(`pty:data:${id}`, data)
      })
      proc.onExit(({ exitCode }) => {
        sessions.delete(id)
        if (!wc.isDestroyed()) wc.send(`pty:exit:${id}`, exitCode)
      })

      if (command) proc.write(command + '\r')
      return id
    }
  )

  ipcMain.on('pty:write', (_event, { id, data }: { id: string; data: string }) => {
    sessions.get(id)?.write(data)
  })

  ipcMain.on(
    'pty:resize',
    (_event, { id, cols, rows }: { id: string; cols: number; rows: number }) => {
      const proc = sessions.get(id)
      if (proc && cols > 0 && rows > 0) {
        try {
          proc.resize(cols, rows)
        } catch {
          // el proceso pudo morir entre el get y el resize
        }
      }
    }
  )

  ipcMain.on('pty:kill', (_event, { id }: { id: string }) => {
    const proc = sessions.get(id)
    if (proc) {
      sessions.delete(id)
      try {
        proc.kill()
      } catch {
        // ya estaba muerto
      }
    }
  })
}

export function killAllPtys(): void {
  for (const proc of sessions.values()) {
    try {
      proc.kill()
    } catch {
      // ignorar
    }
  }
  sessions.clear()
}
