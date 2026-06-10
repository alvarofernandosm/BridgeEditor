import { app, BrowserWindow, ipcMain, dialog, shell, Menu } from 'electron'
import { appendFile } from 'fs'
import { join } from 'path'
import os from 'os'
import { registerPtyHandlers, killAllPtys } from './pty'
import { registerFileHandlers, unwatchAllFiles } from './files'
import { registerChatHandlers, killAllChats } from './chat'
import { registerBridge } from './bridge'
import { registerCheckpointHandlers } from './checkpoints'

// En sesiones Wayland corre como cliente Wayland nativo (en X11 sigue X11).
// Como cliente XWayland, arrastrar VARIOS archivos desde Nautilus no funciona:
// el puente XDND solo entrega uno; el soporte completo está en el ozone Wayland.
app.commandLine.appendSwitch('ozone-platform-hint', 'auto')

let mainWindow: BrowserWindow | null = null

// Las acciones del menú viajan al renderer, que las despacha a las mismas
// funciones de la paleta. Los aceleradores Ctrl+Shift+* ya los maneja el
// renderer: se muestran pero no se registran (evita doble disparo).
function sendMenuAction(action: string): void {
  const wc = mainWindow?.webContents
  if (wc && !wc.isDestroyed()) wc.send('menu:action', action)
}

function buildAppMenu(): void {
  const template: Electron.MenuItemConstructorOptions[] = [
    ...(process.platform === 'darwin'
      ? [{ role: 'appMenu' as const }]
      : []),
    {
      label: 'Archivo',
      submenu: [
        { label: 'Nueva celda', click: () => sendMenuAction('new-cell') },
        { label: 'Abrir archivo en la celda activa…', click: () => sendMenuAction('open-file') },
        { type: 'separator' },
        { role: 'quit', label: 'Salir' }
      ]
    },
    {
      label: 'Celda',
      submenu: [
        {
          label: 'Insertar ruta de archivo…',
          accelerator: 'Ctrl+Shift+A',
          registerAccelerator: false,
          click: () => sendMenuAction('insert-file')
        },
        {
          label: 'Insertar ruta de carpeta…',
          accelerator: 'Ctrl+Shift+D',
          registerAccelerator: false,
          click: () => sendMenuAction('insert-dir')
        },
        { type: 'separator' },
        { label: 'Cerrar celda activa', click: () => sendMenuAction('close-active') }
      ]
    },
    {
      label: 'Workspace',
      submenu: [
        { label: '📸 Crear punto de control…', click: () => sendMenuAction('ckpt-save') },
        { label: '⏪ Restaurar punto de control…', click: () => sendMenuAction('ckpt-restore') },
        { type: 'separator' },
        { label: '💾 Guardar layout como plantilla…', click: () => sendMenuAction('template-save') }
      ]
    },
    {
      label: 'Ayuda',
      submenu: [
        {
          label: 'Paleta de comandos',
          accelerator: 'Ctrl+Shift+P',
          registerAccelerator: false,
          click: () => sendMenuAction('palette')
        },
        { type: 'separator' },
        {
          label: 'GitHub del proyecto',
          click: () => shell.openExternal('https://github.com/alvarofernandosm/BridgeEditor')
        },
        {
          label: 'Acerca de BridgeEditor',
          click: () =>
            dialog.showMessageBox({
              title: 'BridgeEditor',
              message: `BridgeEditor v${app.getVersion()}`,
              detail:
                'IDE agéntico: grilla dinámica de terminales, chats y visores para ' +
                'Claude Code y OpenCode, con delegación multi-agente y puntos de ' +
                'control del workspace.\n\nMIT · github.com/alvarofernandosm/BridgeEditor'
            })
        }
      ]
    }
  ]
  Menu.setApplicationMenu(Menu.buildFromTemplate(template))
}

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
    autoHideMenuBar: false,
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
  buildAppMenu()

  registerPtyHandlers()
  registerFileHandlers()
  registerChatHandlers()
  registerCheckpointHandlers()
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

  // Caja negra del drag & drop: cada drop registra qué entregó Chromium
  // (tipos, files, uri-list) para diagnosticar sin adivinar.
  ipcMain.on('debug:dnd', (_event, info: unknown) => {
    const line = `${new Date().toISOString()} ${JSON.stringify(info)}\n`
    appendFile(join(os.tmpdir(), 'bridgeeditor-dnd.log'), line, () => {})
  })

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
