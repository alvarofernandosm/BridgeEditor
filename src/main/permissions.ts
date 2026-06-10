import { app } from 'electron'
import { writeFileSync } from 'fs'
import { join } from 'path'

export type PermLevel = 'default' | 'flexible' | 'yolo'

// Preset "flexible" para Claude Code (se pasa con --settings, que MERGEA con
// la config del usuario): auto-aprueba lo cotidiano y seguro. Lo crítico
// sigue preguntando porque NO está en la lista: sudo, rm, chmod, kill,
// git push, curl/wget, instalación de paquetes del sistema, y WebFetch de
// contenido arbitrario (el vector típico de prompt injection). WebSearch sí
// se permite: sus resultados llegan curados por la herramienta.
const CLAUDE_FLEXIBLE = {
  permissions: {
    allow: [
      'Edit',
      'Write',
      'NotebookEdit',
      'WebSearch',
      'Bash(git status:*)',
      'Bash(git diff:*)',
      'Bash(git log:*)',
      'Bash(git show:*)',
      'Bash(git add:*)',
      'Bash(git commit:*)',
      'Bash(git branch:*)',
      'Bash(git checkout:*)',
      'Bash(git switch:*)',
      'Bash(git stash:*)',
      'Bash(ls:*)',
      'Bash(cat:*)',
      'Bash(head:*)',
      'Bash(tail:*)',
      'Bash(grep:*)',
      'Bash(rg:*)',
      'Bash(find:*)',
      'Bash(wc:*)',
      'Bash(mkdir:*)',
      'Bash(node:*)',
      'Bash(npx:*)',
      'Bash(npm run:*)',
      'Bash(npm test:*)',
      'Bash(npm ci:*)',
      'Bash(npm install:*)',
      'Bash(python3:*)',
      'Bash(make:*)',
      'Bash(cargo build:*)',
      'Bash(cargo test:*)',
      'Bash(go build:*)',
      'Bash(go test:*)'
    ]
  }
}

// Equivalente para OpenCode vía la env OPENCODE_PERMISSION (las versiones
// que no la soportan la ignoran sin romper nada).
const OPENCODE_FLEXIBLE = {
  edit: 'allow',
  webfetch: 'ask',
  bash: {
    '*': 'ask',
    'git status*': 'allow',
    'git diff*': 'allow',
    'git log*': 'allow',
    'git add*': 'allow',
    'git commit*': 'allow',
    'ls*': 'allow',
    'cat*': 'allow',
    'grep*': 'allow',
    'rg*': 'allow',
    'find*': 'allow',
    'node*': 'allow',
    'npm run*': 'allow',
    'npm test*': 'allow'
  }
}

const OPENCODE_YOLO = { edit: 'allow', webfetch: 'allow', bash: 'allow' }

let cachedPath: string | null = null

export function claudeFlexibleSettingsPath(): string {
  if (!cachedPath) {
    cachedPath = join(app.getPath('userData'), 'claude-permisos-flexibles.json')
    // se reescribe en cada arranque para que las actualizaciones del preset apliquen
    writeFileSync(cachedPath, JSON.stringify(CLAUDE_FLEXIBLE, null, 2))
  }
  return cachedPath
}

/** Ajusta el comando del agente y su entorno según el nivel de permisos. */
export function applyPermissions(
  command: string | null,
  perm: PermLevel
): { command: string | null; env: Record<string, string> } {
  if (!command || perm === 'default') return { command, env: {} }

  if (command === 'claude') {
    if (perm === 'yolo') {
      return { command: 'claude --dangerously-skip-permissions', env: {} }
    }
    return { command: `claude --settings '${claudeFlexibleSettingsPath()}'`, env: {} }
  }

  if (command === 'opencode') {
    const permission = perm === 'yolo' ? OPENCODE_YOLO : OPENCODE_FLEXIBLE
    return { command, env: { OPENCODE_PERMISSION: JSON.stringify(permission) } }
  }

  return { command, env: {} }
}
