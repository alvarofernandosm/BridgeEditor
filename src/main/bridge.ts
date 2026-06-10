import { app, dialog, ipcMain, type BrowserWindow } from 'electron'
import { createServer, type IncomingMessage, type ServerResponse } from 'http'
import { randomUUID } from 'crypto'
import { mkdirSync, writeFileSync } from 'fs'
import { join } from 'path'
import { homedir } from 'os'
import { executeChatTurn } from './chat'
import { setBridgeEnv } from './bridge-state'

// Puente de delegación entre celdas: un servidor HTTP local (solo loopback,
// con token) que permite a un agente listar las demás celdas y delegarles
// trabajo. El destino debe estar en modo chat; el turno delegado se ve en
// vivo en su ChatView y la respuesta vuelve al orquestador como JSON.

interface CellInfo {
  id: string
  index: number
  label: string
  agent: 'claude' | 'opencode' | 'shell' | null
  mode: 'term' | 'chat'
  cwd: string
  perm: 'default' | 'flexible' | 'yolo'
  chatSessionId: string | null
  chatModel: string | null
  busy: boolean
}

let registry: CellInfo[] = []
const delegating = new Set<string>()
/** clave `${origen}→${destino}` → true (siempre permitir en esta sesión) */
const grantedPairs = new Set<string>()

const PERM_MAP = { default: 'edits', flexible: 'flexible', yolo: 'full' } as const

function findCell(target: unknown): CellInfo | undefined {
  if (typeof target === 'number') return registry.find((c) => c.index === target)
  if (typeof target === 'string') {
    return registry.find((c) => c.id === target) ?? registry.find((c) => String(c.index) === target)
  }
  return undefined
}

async function askPermission(
  win: BrowserWindow | null,
  fromLabel: string,
  target: CellInfo
): Promise<boolean> {
  const key = `${fromLabel}→${target.id}`
  if (grantedPairs.has(key)) return true
  if (!win) return false
  const { response } = await dialog.showMessageBox(win, {
    type: 'question',
    title: 'Delegación entre celdas',
    message: `${fromLabel} quiere delegar trabajo en la celda ${target.index} (${target.label})`,
    detail: `Directorio: ${target.cwd}\n\nEl agente orquestador podrá enviarle tareas y leer sus respuestas.`,
    buttons: ['Permitir siempre (esta sesión)', 'Permitir una vez', 'Denegar'],
    defaultId: 0,
    cancelId: 2
  })
  if (response === 0) grantedPairs.add(key)
  return response !== 2
}

function readBody(req: IncomingMessage): Promise<string> {
  return new Promise((resolve, reject) => {
    let body = ''
    req.on('data', (chunk) => {
      body += chunk
      if (body.length > 1_000_000) reject(new Error('payload demasiado grande'))
    })
    req.on('end', () => resolve(body))
    req.on('error', reject)
  })
}

function json(res: ServerResponse, status: number, payload: unknown): void {
  res.writeHead(status, { 'Content-Type': 'application/json' })
  res.end(JSON.stringify(payload))
}

export function registerBridge(getWindow: () => BrowserWindow | null): void {
  ipcMain.on('cells:sync', (_event, cells: CellInfo[]) => {
    registry = cells
  })

  const token = randomUUID()

  const server = createServer(async (req, res) => {
    if (req.headers.authorization !== `Bearer ${token}`) {
      return json(res, 401, { error: 'token inválido' })
    }

    if (req.method === 'GET' && req.url === '/cells') {
      return json(
        res,
        200,
        registry.map((c) => ({
          id: c.id,
          index: c.index,
          label: c.label,
          agent: c.agent,
          mode: c.mode,
          cwd: c.cwd,
          model: c.chatModel,
          busy: c.busy || delegating.has(c.id),
          acceptsDelegation: c.mode === 'chat' && c.agent !== null && c.agent !== 'shell'
        }))
      )
    }

    if (req.method === 'POST' && req.url === '/delegate') {
      let body: { target?: unknown; message?: unknown; from?: unknown }
      try {
        body = JSON.parse(await readBody(req))
      } catch {
        return json(res, 400, { error: 'JSON inválido' })
      }
      const message = typeof body.message === 'string' ? body.message.trim() : ''
      if (!message) return json(res, 400, { error: 'falta "message"' })

      const target = findCell(body.target)
      if (!target) return json(res, 404, { error: `no existe la celda ${String(body.target)}` })
      if (target.mode !== 'chat' || !target.agent || target.agent === 'shell') {
        return json(res, 409, {
          error: `la celda ${target.index} no está en modo chat: solo las celdas de chat aceptan delegación. Pide al usuario abrir un chat (launcher → Chat agéntico).`
        })
      }
      if (target.busy || delegating.has(target.id)) {
        return json(res, 409, { error: `la celda ${target.index} está ocupada; reintenta en unos segundos` })
      }

      const fromCell = typeof body.from === 'string' ? findCell(body.from) : undefined
      const fromLabel = fromCell ? `La celda ${fromCell.index} (${fromCell.label})` : 'Un agente'
      if (fromCell?.id === target.id) return json(res, 400, { error: 'no puedes delegarte a ti mismo' })

      const win = getWindow()
      if (!(await askPermission(win, fromLabel, target))) {
        return json(res, 403, { error: 'el usuario denegó la delegación' })
      }

      delegating.add(target.id)
      const emit = (payload: unknown): void => {
        const wc = getWindow()?.webContents
        if (wc && !wc.isDestroyed()) wc.send(`chat:event:${target.id}`, payload)
      }
      try {
        emit({ kind: 'remote-user', text: message, from: fromLabel })
        emit({ kind: 'turn-start' })
        const result = await executeChatTurn(
          {
            id: target.id,
            agent: target.agent,
            cwd: target.cwd,
            message,
            sessionId: target.chatSessionId,
            permissionMode: PERM_MAP[target.perm] ?? 'edits',
            model: target.chatModel
          },
          emit
        )
        return json(res, result.error ? 502 : 200, {
          ok: !result.error,
          cell: target.index,
          text: result.text,
          error: result.error
        })
      } finally {
        delegating.delete(target.id)
      }
    }

    return json(res, 404, { error: 'ruta desconocida: usa GET /cells o POST /delegate' })
  })

  server.requestTimeout = 0
  server.timeout = 0
  server.listen(0, '127.0.0.1', () => {
    const address = server.address()
    if (address && typeof address === 'object') {
      setBridgeEnv({
        BRIDGE_API: `http://127.0.0.1:${address.port}`,
        BRIDGE_TOKEN: token
      })
      writeDelegationSkill()
    }
  })

  app.on('before-quit', () => server.close())
}

// Skill para Claude Code: enseña a los agentes a delegar entre celdas.
// Referencia las env vars (el puerto y el token cambian en cada arranque).
function writeDelegationSkill(): void {
  try {
    const dir = join(homedir(), '.claude', 'skills', 'bridge-cells')
    mkdirSync(dir, { recursive: true })
    writeFileSync(
      join(dir, 'SKILL.md'),
      `---
name: bridge-cells
description: Delegar trabajo a los agentes de otras celdas de BridgeEditor — listar celdas, enviarles tareas y recibir sus respuestas. Usar cuando el usuario pida delegar, coordinar u orquestar trabajo entre tabs/celdas del editor.
---

# Delegación entre celdas de BridgeEditor

Estás corriendo dentro de una celda de BridgeEditor. Si \`$BRIDGE_API\` y
\`$BRIDGE_TOKEN\` existen en tu entorno, puedes delegar tareas a los agentes de
las otras celdas (tu propia celda es \`$BRIDGE_CELL_ID\`).

## Listar celdas

\`\`\`bash
curl -s "$BRIDGE_API/cells" -H "Authorization: Bearer $BRIDGE_TOKEN"
\`\`\`

Devuelve índice, agente, directorio y si la celda acepta delegación
(\`acceptsDelegation\`: solo las celdas en modo chat).

## Delegar una tarea (bloquea hasta recibir la respuesta)

\`\`\`bash
curl -s -X POST "$BRIDGE_API/delegate" \\
  -H "Authorization: Bearer $BRIDGE_TOKEN" \\
  -H "Content-Type: application/json" \\
  --max-time 900 \\
  -d "{\\"target\\": 2, \\"message\\": \\"<tarea clara y autocontenida>\\", \\"from\\": \\"$BRIDGE_CELL_ID\\"}"
\`\`\`

- \`target\`: número de celda (1-6) o su id.
- La respuesta JSON trae \`.text\` con la respuesta completa del agente.
- Usa \`--max-time\` generoso (las tareas tardan minutos) y delega tareas
  autocontenidas: el otro agente no ve tu conversación.
- La primera vez el usuario verá un diálogo de permiso; \`403\` significa que
  denegó, \`409\` que la celda está ocupada o no es de tipo chat.
- Puedes delegar a varias celdas en paralelo lanzando los curl en background
  y recogiendo los resultados.
`
    )
  } catch {
    // sin permisos para escribir el skill: la delegación sigue funcionando vía curl
  }
}
