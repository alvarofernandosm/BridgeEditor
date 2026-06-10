// Wrapper de desarrollo multiplataforma.
//
// En Ubuntu 24+ AppArmor restringe los user namespaces sin privilegios y el
// helper chrome-sandbox de node_modules no tiene setuid root, así que Electron
// aborta al arrancar. Ese chequeo de Chromium ocurre antes de que corra el
// proceso main, por lo que la única salida sin sudo es ELECTRON_DISABLE_SANDBOX.
// Solo se aplica cuando se detecta el problema; en macOS/Windows es un no-op.
import { spawn } from 'node:child_process'
import { readFileSync, statSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

const root = join(dirname(fileURLToPath(import.meta.url)), '..')

function needsSandboxOff() {
  if (process.platform !== 'linux') return false
  try {
    const restricted = readFileSync(
      '/proc/sys/kernel/apparmor_restrict_unprivileged_userns',
      'utf8'
    ).trim()
    if (restricted !== '1') return false
  } catch {
    return false
  }
  try {
    const helper = statSync(join(root, 'node_modules/electron/dist/chrome-sandbox'))
    return !(helper.uid === 0 && (helper.mode & 0o4000) !== 0)
  } catch {
    return true
  }
}

const env = { ...process.env }
if (needsSandboxOff()) {
  console.warn(
    '[dev] AppArmor restringe userns y chrome-sandbox no tiene setuid root: ' +
      'se usa ELECTRON_DISABLE_SANDBOX=1.\n' +
      '[dev] Alternativa permanente: sudo chown root:root node_modules/electron/dist/chrome-sandbox && sudo chmod 4755 node_modules/electron/dist/chrome-sandbox'
  )
  env.ELECTRON_DISABLE_SANDBOX = '1'
}

const child = spawn(
  process.execPath,
  [join(root, 'node_modules/electron-vite/bin/electron-vite.js'), 'dev'],
  { stdio: 'inherit', env, cwd: root }
)
child.on('exit', (code) => process.exit(code ?? 0))
