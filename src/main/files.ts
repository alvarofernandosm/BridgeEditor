import { ipcMain, dialog } from 'electron'
import { readFile, writeFile, stat } from 'fs/promises'
import { watchFile, unwatchFile, type Stats } from 'fs'
import { isAbsolute, join, resolve } from 'path'
import { homedir } from 'os'

const MAX_FILE_BYTES = 2 * 1024 * 1024

type WatchEntry = { path: string; listener: (curr: Stats, prev: Stats) => void }
const watchers = new Map<string, WatchEntry>()

export function registerFileHandlers(): void {
  ipcMain.handle('dialog:pickFile', async () => {
    const res = await dialog.showOpenDialog({
      title: 'Abrir archivo',
      properties: ['openFile'],
      filters: [
        { name: 'Markdown', extensions: ['md', 'markdown'] },
        { name: 'Texto y código', extensions: ['txt', 'json', 'yml', 'yaml', 'ts', 'tsx', 'js', 'py', 'sh', 'toml', 'css', 'html'] },
        { name: 'Todos los archivos', extensions: ['*'] }
      ]
    })
    return res.canceled ? null : res.filePaths[0]
  })

  ipcMain.handle('file:read', async (_event, path: string) => {
    const content = await readFile(path, 'utf8')
    if (Buffer.byteLength(content, 'utf8') > MAX_FILE_BYTES) {
      throw new Error('Archivo demasiado grande para el visor (>2MB)')
    }
    return content
  })

  ipcMain.handle('file:write', async (_event, { path, content }: { path: string; content: string }) => {
    await writeFile(path, content, 'utf8')
  })

  // Resuelve una ruta candidata (relativa al cwd de la celda, ~ expandido) y
  // devuelve la ruta absoluta solo si existe y es un archivo. Para los links
  // clicables de la terminal.
  ipcMain.handle(
    'file:resolveExisting',
    async (_event, { path, cwd }: { path: string; cwd: string }) => {
      let candidate = path
      if (candidate.startsWith('~')) candidate = join(homedir(), candidate.slice(1))
      if (!isAbsolute(candidate)) candidate = resolve(cwd || homedir(), candidate)
      try {
        const info = await stat(candidate)
        return info.isFile() ? candidate : null
      } catch {
        return null
      }
    }
  )

  // Vigilancia por polling (fs.watchFile): sobrevive a los renombrados con los
  // que la mayoría de editores y agentes guardan archivos.
  ipcMain.on('file:watch', (event, { id, path }: { id: string; path: string }) => {
    const prev = watchers.get(id)
    if (prev) unwatchFile(prev.path, prev.listener)

    const wc = event.sender
    const listener: WatchEntry['listener'] = (curr, prevStat) => {
      if (curr.mtimeMs !== prevStat.mtimeMs && !wc.isDestroyed()) {
        wc.send(`file:changed:${id}`)
      }
    }
    watchFile(path, { interval: 800 }, listener)
    watchers.set(id, { path, listener })
  })

  ipcMain.on('file:unwatch', (_event, { id }: { id: string }) => {
    const entry = watchers.get(id)
    if (entry) {
      unwatchFile(entry.path, entry.listener)
      watchers.delete(id)
    }
  })
}

export function unwatchAllFiles(): void {
  for (const entry of watchers.values()) {
    unwatchFile(entry.path, entry.listener)
  }
  watchers.clear()
}
