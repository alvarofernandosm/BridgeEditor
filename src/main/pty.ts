import { ipcMain, type WebContents } from 'electron'
import * as pty from 'node-pty'
import { readdir, stat } from 'fs/promises'
import { join } from 'path'
import { homedir } from 'os'
import { applyPermissions, type PermLevel } from './permissions'
import { bridgeEnv } from './bridge-state'

const sessions = new Map<string, pty.IPty>()

// Atribución de sesiones de Claude por celda: al lanzar el TUI se vigila
// ~/.claude/projects/<cwd-codificado>/ hasta ver qué .jsonl nuevo aparece;
// ese session id pertenece a la celda y permite un --resume exacto al
// restaurar el layout (--continue mezclaría celdas del mismo directorio).
const claimedSessions = new Set<string>()
const sessionTimers = new Map<string, ReturnType<typeof setInterval>>()

function trackClaudeSession(id: string, cwd: string, wc: WebContents): void {
  const dir = join(homedir(), '.claude', 'projects', cwd.replace(/[^a-zA-Z0-9]/g, '-'))
  const spawnTime = Date.now()
  let attempts = 0
  const timer = setInterval(async () => {
    attempts++
    if (attempts > 40 || !sessions.has(id)) {
      clearInterval(timer)
      sessionTimers.delete(id)
      return
    }
    try {
      const names = await readdir(dir)
      const candidates: Array<{ sid: string; mtimeMs: number }> = []
      for (const name of names) {
        if (!name.endsWith('.jsonl')) continue
        const sid = name.slice(0, -6)
        if (claimedSessions.has(sid)) continue
        const info = await stat(join(dir, name)).catch(() => null)
        if (info && info.mtimeMs >= spawnTime - 2000) candidates.push({ sid, mtimeMs: info.mtimeMs })
      }
      if (candidates.length > 0) {
        // el más antiguo de los nuevos: si dos celdas arrancaron a la vez,
        // cada poll reclama uno distinto en orden de creación
        candidates.sort((a, b) => a.mtimeMs - b.mtimeMs)
        const sid = candidates[0].sid
        claimedSessions.add(sid)
        if (!wc.isDestroyed()) wc.send(`pty:session:${id}`, sid)
        clearInterval(timer)
        sessionTimers.delete(id)
      }
    } catch {
      // el directorio del proyecto aún no existe
    }
  }, 3000)
  sessionTimers.set(id, timer)
}

function stopTracking(id: string): void {
  const timer = sessionTimers.get(id)
  if (timer) {
    clearInterval(timer)
    sessionTimers.delete(id)
  }
}

function defaultShell(): string {
  if (process.platform === 'win32') return 'powershell.exe'
  return process.env.SHELL || '/bin/bash'
}

export function registerPtyHandlers(): void {
  ipcMain.handle(
    'pty:create',
    (
      event,
      opts: {
        id: string
        cellId?: string
        cwd: string
        command: string | null
        perm?: PermLevel
        resumeSession?: string | null
        cols: number
        rows: number
      }
    ) => {
      const { id, cwd, cols, rows } = opts
      const applied = applyPermissions(opts.command, opts.perm ?? 'default')
      const permEnv = applied.env
      let command = applied.command
      const isClaude = command?.startsWith('claude') ?? false
      // Celda restaurada con sesión conocida: --resume exacto de ESA conversación.
      if (opts.resumeSession && isClaude) {
        claimedSessions.add(opts.resumeSession)
        command += ` --resume '${opts.resumeSession.replace(/'/g, '')}'`
      }
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
          ...permEnv,
          ...bridgeEnv(),
          ...(opts.cellId ? { BRIDGE_CELL_ID: opts.cellId } : {}),
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
        stopTracking(id)
        if (!wc.isDestroyed()) wc.send(`pty:exit:${id}`, exitCode)
      })

      if (command) proc.write(command + '\r')

      // Sesión nueva de claude: detectar qué session id le corresponde a esta celda.
      if (isClaude && !opts.resumeSession) trackClaudeSession(id, cwd, wc)

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
    stopTracking(id)
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
