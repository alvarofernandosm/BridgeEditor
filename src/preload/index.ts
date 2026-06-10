import { contextBridge, ipcRenderer, clipboard, webUtils } from 'electron'

const api = {
  platform: process.platform as string,

  /** Menú contextual nativo de la terminal. Devuelve la acción elegida o ''. */
  termMenu: (hasSelection: boolean): Promise<string> =>
    ipcRenderer.invoke('ui:termMenu', hasSelection),

  /** Portapapeles primario de X11/Wayland (selección con mouse + clic del medio). */
  writePrimary: (text: string): void => {
    if (process.platform === 'linux') clipboard.writeText(text, 'selection')
  },

  readPrimary: (): string => (process.platform === 'linux' ? clipboard.readText('selection') : ''),

  /** Ruta real en disco de un File arrastrado (drag & drop). */
  filePathFor: (file: File): string => webUtils.getPathForFile(file),

  chatSend: (opts: {
    id: string
    agent: 'claude' | 'opencode'
    cwd: string
    message: string
    sessionId: string | null
    permissionMode: 'plan' | 'edits' | 'flexible' | 'full'
    model?: string | null
  }): Promise<void> => ipcRenderer.invoke('chat:send', opts),

  chatModels: (agent: 'claude' | 'opencode'): Promise<string[]> =>
    ipcRenderer.invoke('chat:models', agent),

  chatCancel: (id: string): void => ipcRenderer.send('chat:cancel', { id }),

  chatSessions: (cwd: string): Promise<Array<{ id: string; mtimeMs: number; summary: string }>> =>
    ipcRenderer.invoke('chat:sessions', cwd),

  onChatEvent: (id: string, cb: (ev: unknown) => void): (() => void) => {
    const channel = `chat:event:${id}`
    const listener = (_event: unknown, payload: unknown): void => cb(payload)
    ipcRenderer.on(channel, listener)
    return () => ipcRenderer.removeListener(channel, listener)
  },

  /** Sincroniza el estado de las celdas hacia el main (puente de delegación). */
  syncCells: (cells: unknown[]): void => ipcRenderer.send('cells:sync', cells),

  createPty: (opts: {
    id: string
    cellId?: string
    cwd: string
    command: string | null
    perm?: 'default' | 'flexible' | 'yolo'
    resumeSession?: string | null
    cols: number
    rows: number
  }): Promise<string> => ipcRenderer.invoke('pty:create', opts),

  /** Notifica el session id de claude detectado para una celda de terminal. */
  onPtySession: (id: string, cb: (sessionId: string) => void): (() => void) => {
    const channel = `pty:session:${id}`
    const listener = (_event: unknown, sessionId: string): void => cb(sessionId)
    ipcRenderer.on(channel, listener)
    return () => ipcRenderer.removeListener(channel, listener)
  },

  write: (id: string, data: string): void => ipcRenderer.send('pty:write', { id, data }),

  resize: (id: string, cols: number, rows: number): void =>
    ipcRenderer.send('pty:resize', { id, cols, rows }),

  kill: (id: string): void => ipcRenderer.send('pty:kill', { id }),

  onData: (id: string, cb: (data: string) => void): (() => void) => {
    const channel = `pty:data:${id}`
    const listener = (_event: unknown, data: string): void => cb(data)
    ipcRenderer.on(channel, listener)
    return () => ipcRenderer.removeListener(channel, listener)
  },

  onExit: (id: string, cb: (code: number) => void): (() => void) => {
    const channel = `pty:exit:${id}`
    const listener = (_event: unknown, code: number): void => cb(code)
    ipcRenderer.on(channel, listener)
    return () => ipcRenderer.removeListener(channel, listener)
  },

  pickDirectory: (): Promise<string | null> => ipcRenderer.invoke('dialog:pickDirectory'),

  homeDir: (): Promise<string> => ipcRenderer.invoke('app:homeDir'),

  appVersion: (): Promise<string> => ipcRenderer.invoke('app:version'),

  pickFile: (): Promise<string | null> => ipcRenderer.invoke('dialog:pickFile'),

  readFile: (path: string): Promise<string> => ipcRenderer.invoke('file:read', path),

  writeFile: (path: string, content: string): Promise<void> =>
    ipcRenderer.invoke('file:write', { path, content }),

  resolveExisting: (path: string, cwd: string): Promise<string | null> =>
    ipcRenderer.invoke('file:resolveExisting', { path, cwd }),

  watchFile: (id: string, path: string, cb: () => void): (() => void) => {
    const channel = `file:changed:${id}`
    const listener = (): void => cb()
    ipcRenderer.on(channel, listener)
    ipcRenderer.send('file:watch', { id, path })
    return () => {
      ipcRenderer.removeListener(channel, listener)
      ipcRenderer.send('file:unwatch', { id })
    }
  }
}

contextBridge.exposeInMainWorld('bridge', api)

export type BridgeApi = typeof api
