export {}

declare global {
  type ChatEvent =
    | { kind: 'init'; sessionId: string }
    | { kind: 'remote-user'; text: string; from: string }
    | { kind: 'turn-start' }
    | { kind: 'text'; text: string }
    | { kind: 'chunk'; text: string }
    | { kind: 'tool'; name: string; detail: string }
    | { kind: 'done'; sessionId: string | null; meta?: string | null; error?: string | null }
    | { kind: 'error'; message: string }

  interface Window {
    bridge: {
      platform: string
      termMenu(hasSelection: boolean): Promise<string>
      writePrimary(text: string): void
      readPrimary(): string
      filePathFor(file: File): string
      chatSend(opts: {
        id: string
        agent: 'claude' | 'opencode'
        cwd: string
        message: string
        sessionId: string | null
        permissionMode: 'plan' | 'edits' | 'flexible' | 'full'
        model?: string | null
      }): Promise<void>
      chatModels(agent: 'claude' | 'opencode'): Promise<string[]>
      chatCancel(id: string): void
      chatSessions(cwd: string): Promise<Array<{ id: string; mtimeMs: number; summary: string }>>
      onChatEvent(id: string, cb: (ev: ChatEvent) => void): () => void
      syncCells(cells: unknown[]): void
      createPty(opts: {
        id: string
        cellId?: string
        cwd: string
        command: string | null
        perm?: 'default' | 'flexible' | 'yolo'
        resumeSession?: string | null
        cols: number
        rows: number
      }): Promise<string>
      onPtySession(id: string, cb: (sessionId: string) => void): () => void
      write(id: string, data: string): void
      resize(id: string, cols: number, rows: number): void
      kill(id: string): void
      onData(id: string, cb: (data: string) => void): () => void
      onExit(id: string, cb: (code: number) => void): () => void
      pickDirectory(): Promise<string | null>
      homeDir(): Promise<string>
      appVersion(): Promise<string>
      pickFile(): Promise<string | null>
      readFile(path: string): Promise<string>
      writeFile(path: string, content: string): Promise<void>
      resolveExisting(path: string, cwd: string): Promise<string | null>
      watchFile(id: string, path: string, cb: () => void): () => void
    }
  }
}
