import { app, BrowserWindow, ipcMain, dialog, shell, Menu } from 'electron'
import { join } from 'path'
import os from 'os'
import { registerPtyHandlers, killAllPtys } from './pty'
import { registerFileHandlers, unwatchAllFiles } from './files'
import { registerChatHandlers, killAllChats } from './chat'
import { registerBridge } from './bridge'

let mainWindow: BrowserWindow | null = null

function createWindow(): void {
  const iconPath = app.isPackaged
    ? join(process.resourcesPath, 'icon.png')
    : join(__dirname, '../../build/icon.png')

  const win = new BrowserWindow({
    width: 1500,
    height: 900,
    minWidth: 800,
    minHeight: 500,
    show: false,
    backgroundColor: '#0d1117',
    title: 'BridgeEditor',
    icon: iconPath,
    autoHideMenuBar: true,
    webPreferences: {
      preload: join(__dirname, '../preload/index.js'),
      sandbox: false
    }
  })

  mainWindow = win
  win.on('closed', () => {
    if (mainWindow === win) mainWindow = null
  })

  win.on('ready-to-show', () => win.show())

  // Los enlaces que impriman los agentes (OAuth de Claude, docs, etc.)
  // se abren en el navegador del sistema, nunca dentro de la app.
  win.webContents.setWindowOpenHandler(({ url }) => {
    shell.openExternal(url)
    return { action: 'deny' }
  })

  // Los links del visor de Markdown tampoco navegan dentro de la app.
  win.webContents.on('will-navigate', (e, url) => {
    const current = win.webContents.getURL()
    try {
      if (current && new URL(url).origin === new URL(current).origin) return
    } catch {
      // URL inválida: bloquear
    }
    e.preventDefault()
    if (/^https?:/.test(url)) shell.openExternal(url)
  })

  // Sin menú de aplicación no quedan aceleradores de devtools: F12 en dev.
  if (process.env['ELECTRON_RENDERER_URL']) {
    win.webContents.on('before-input-event', (e, input) => {
      if (input.type === 'keyDown' && input.key === 'F12') {
        win.webContents.toggleDevTools()
        e.preventDefault()
      }
    })
  }

  if (process.env['ELECTRON_RENDERER_URL']) {
    win.loadURL(process.env['ELECTRON_RENDERER_URL'])
  } else {
    win.loadFile(join(__dirname, '../renderer/index.html'))
  }
}

app.whenReady().then(() => {
  // En Linux/Windows el menú por defecto intercepta Ctrl+C (rol "copy") y nunca
  // llega a la terminal. En macOS se conserva: ahí los roles de Edit son los que
  // hacen funcionar Cmd+C/V en los inputs y el editor de archivos.
  if (process.platform !== 'darwin') Menu.setApplicationMenu(null)

  registerPtyHandlers()
  registerFileHandlers()
  registerChatHandlers()
  registerBridge(() => mainWindow)

  // Menú contextual nativo de la terminal; resuelve con la acción elegida.
  ipcMain.handle('ui:termMenu', (event, hasSelection: boolean) => {
    return new Promise<string>((resolve) => {
      let done = false
      const pick = (action: string): void => {
        if (!done) {
          done = true
          resolve(action)
        }
      }
      const menu = Menu.buildFromTemplate([
        {
          label: 'Copiar',
          enabled: hasSelection,
          accelerator: 'Ctrl+Shift+C',
          registerAccelerator: false,
          click: () => pick('copy')
        },
        {
          label: 'Pegar',
          accelerator: 'Ctrl+Shift+V',
          registerAccelerator: false,
          click: () => pick('paste')
        },
        { type: 'separator' },
        { label: 'Seleccionar todo', click: () => pick('selectAll') },
        { label: 'Limpiar terminal', click: () => pick('clear') }
      ])
      menu.popup({
        window: BrowserWindow.fromWebContents(event.sender) ?? undefined,
        // callback corre al cerrar el menú; el click llega justo después
        callback: () => setTimeout(() => pick(''), 60)
      })
    })
  })

  ipcMain.handle('dialog:pickDirectory', async () => {
    const res = await dialog.showOpenDialog({
      title: 'Elegir directorio de trabajo',
      properties: ['openDirectory', 'createDirectory']
    })
    return res.canceled ? null : res.filePaths[0]
  })

  ipcMain.handle('app:homeDir', () => os.homedir())
  ipcMain.handle('app:version', () => app.getVersion())

  createWindow()

  app.on('activate', () => {
    if (BrowserWindow.getAllWindows().length === 0) createWindow()
  })
})

app.on('window-all-closed', () => {
  killAllPtys()
  killAllChats()
  unwatchAllFiles()
  app.quit()
})

app.on('before-quit', () => {
  killAllPtys()
  killAllChats()
  unwatchAllFiles()
})
