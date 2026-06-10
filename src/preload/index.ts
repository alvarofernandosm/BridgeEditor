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

  /** Registro de diagnóstico de drops (a <tmp>/bridgeeditor-dnd.log). */
  dndDebug: (info: unknown): void => ipcRenderer.send('debug:dnd', info),

  /** Acciones del menú de aplicación (Archivo, Celda, Workspace, Ayuda). */
  onMenuAction: (cb: (action: string) => void): (() => void) => {
    const listener = (_event: unknown, action: string): void => cb(action)
    ipcRenderer.on('menu:action', listener)
    return () => ipcRenderer.removeListener('menu:action', listener)
  },

  chatSend: (opts: {
    id: string
    agent: 'claude' | 'opencode'
    cwd: string
    message: string
    sessionId: string | null
    permissionMode: 'plan' | 'edits' | 'flexible' | 'full'
    model?: string | null
    effort?: string | null
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

  /** Delegación aprobada por clic desde la UI (marcadores @delegate). */
  delegateFromCell: (opts: {
    target: string | number
    message: string
    fromCellId: string
  }): Promise<{ ok?: boolean; cell?: number; text?: string; error?: string | null }> =>
    ipcRenderer.invoke('bridge:delegate', opts),

  /** El main pide abrir una celda (POST /open-cell del puente). */
  onOpenCellRequest: (
    cb: (spec: {
      requestId: string
      agent: 'claude' | 'opencode'
      model: string | null
      effort: string | null
      cwd: string
    }) => void
  ): (() => void) => {
    const listener = (
      _event: unknown,
      spec: {
        requestId: string
        agent: 'claude' | 'opencode'
        model: string | null
        effort: string | null
        cwd: string
      }
    ): void => cb(spec)
    ipcRenderer.on('cells:open-request', listener)
    return () => ipcRenderer.removeListener('cells:open-request', listener)
  },

  openCellResponse: (requestId: string, cellId: string | null): void =>
    ipcRenderer.send('cells:open-response', { requestId, cellId }),

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

  /** Puntos de control del workspace (snapshots git en refs ocultas). */
  ckptCapture: (
    cwd: string,
    label: string
  ): Promise<{ id: string; sha: string; label: string; ts: number; auto: boolean } | null> =>
    ipcRenderer.invoke('ckpt:capture', { cwd, label }),

  ckptList: (
    cwd: string
  ): Promise<Array<{ id: string; sha: string; label: string; ts: number; auto: boolean }>> =>
    ipcRenderer.invoke('ckpt:list', cwd),

  ckptRestore: (cwd: string, sha: string): Promise<{ ok: boolean; error?: string }> =>
    ipcRenderer.invoke('ckpt:restore', { cwd, sha }),

  ckptDelete: (cwd: string, id: string): Promise<void> =>
    ipcRenderer.invoke('ckpt:delete', { cwd, id }),

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
