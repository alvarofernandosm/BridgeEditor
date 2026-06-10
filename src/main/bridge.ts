import { app, dialog, ipcMain, type BrowserWindow } from 'electron'
import { createServer, type IncomingMessage, type ServerResponse } from 'http'
import { randomUUID } from 'crypto'
import { mkdirSync, writeFileSync } from 'fs'
import { join } from 'path'
import { homedir } from 'os'
import { executeChatTurn } from './chat'
import { setBridgeEnv, recordActivity, getActivity } from './bridge-state'

// Puente de delegación entre celdas: un servidor HTTP local (solo loopback,
// con token) que permite a un agente listar celdas, delegarles trabajo,
// consultar el feed de actividad y abrir celdas nuevas. Los destinos en modo
// chat muestran el turno en vivo; las celdas term de claude se "consultan"
// con un fork headless de su conversación (--resume de su session id).

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
  termSessionId: string | null
  busy: boolean
}

let registry: CellInfo[] = []
let getWin: () => BrowserWindow | null = () => null
const delegating = new Set<string>()
/** clave `${origen}→${destino}` → permitir siempre en esta sesión */
const grantedPairs = new Set<string>()

const PERM_MAP = { default: 'edits', flexible: 'flexible', yolo: 'full' } as const
const MAX_CELLS = 6

function findCell(target: unknown): CellInfo | undefined {
  if (typeof target === 'number') return registry.find((c) => c.index === target)
  if (typeof target === 'string') {
    return registry.find((c) => c.id === target) ?? registry.find((c) => String(c.index) === target)
  }
  return undefined
}

const fromLabelOf = (fromCellId: unknown): string => {
  const cell = typeof fromCellId === 'string' ? findCell(fromCellId) : undefined
  return cell ? `La celda ${cell.index} (${cell.label})` : 'Un agente'
}

async function askPermission(fromLabel: string, pairKey: string, message: string, detail: string): Promise<boolean> {
  if (grantedPairs.has(pairKey)) return true
  const win = getWin()
  if (!win) return false
  const { response } = await dialog.showMessageBox(win, {
    type: 'question',
    title: 'Delegación entre celdas',
    message,
    detail,
    buttons: ['Permitir siempre (esta sesión)', 'Permitir una vez', 'Denegar'],
    defaultId: 0,
    cancelId: 2
  })
  if (response === 0) grantedPairs.add(pairKey)
  return response !== 2
}

interface DelegateOutcome {
  status: number
  payload: { ok?: boolean; cell?: number; text?: string; error?: string | null; type?: string }
}

async function delegateToCell(params: {
  targetRef: unknown
  message: string
  fromCellId?: unknown
  skipPermission?: boolean
}): Promise<DelegateOutcome> {
  const target = findCell(params.targetRef)
  if (!target) return { status: 404, payload: { error: `no existe la celda ${String(params.targetRef)}` } }

  const isChatTarget = target.mode === 'chat' && target.agent && target.agent !== 'shell'
  const isConsultTarget =
    target.mode === 'term' && target.agent === 'claude' && target.termSessionId !== null
  if (!isChatTarget && !isConsultTarget) {
    return {
      status: 409,
      payload: {
        error: `la celda ${target.index} no acepta delegación: solo celdas en modo chat, o terminales de Claude con sesión rastreada (consulta). Pide al usuario abrir un chat (launcher → Chat agéntico).`
      }
    }
  }
  if (isChatTarget && (target.busy || delegating.has(target.id))) {
    return { status: 409, payload: { error: `la celda ${target.index} está ocupada; reintenta en unos segundos` } }
  }
  const fromCell = typeof params.fromCellId === 'string' ? findCell(params.fromCellId) : undefined
  if (fromCell?.id === target.id) return { status: 400, payload: { error: 'no puedes delegarte a ti mismo' } }
  const fromLabel = fromLabelOf(params.fromCellId)

  if (!params.skipPermission) {
    const verb = isChatTarget ? 'delegar trabajo en' : 'consultar la conversación de'
    const ok = await askPermission(
      fromLabel,
      `${fromLabel}→${target.id}`,
      `${fromLabel} quiere ${verb} la celda ${target.index} (${target.label})`,
      `Directorio: ${target.cwd}\n\nEl agente orquestador podrá enviarle tareas y leer sus respuestas.`
    )
    if (!ok) return { status: 403, payload: { error: 'el usuario denegó la delegación' } }
  }

  recordActivity({
    cellId: target.id,
    kind: 'delegation',
    detail: `${fromLabel} → celda ${target.index}: ${params.message.replace(/\s+/g, ' ').slice(0, 100)}`
  })

  delegating.add(target.id)
  try {
    if (isChatTarget) {
      const emit = (payload: unknown): void => {
        const wc = getWin()?.webContents
        if (wc && !wc.isDestroyed()) wc.send(`chat:event:${target.id}`, payload)
      }
      emit({ kind: 'remote-user', text: params.message, from: fromLabel })
      emit({ kind: 'turn-start' })
      const result = await executeChatTurn(
        {
          id: target.id,
          agent: target.agent as 'claude' | 'opencode',
          cwd: target.cwd,
          message: params.message,
          sessionId: target.chatSessionId,
          permissionMode: PERM_MAP[target.perm] ?? 'edits',
          model: target.chatModel
        },
        emit
      )
      return {
        status: result.error ? 502 : 200,
        payload: { ok: !result.error, cell: target.index, type: 'chat', text: result.text, error: result.error }
      }
    }

    // Consulta a una terminal de claude: turno headless que hace fork de SU
    // conversación (--resume crea sesión nueva sin tocar la del TUI).
    const result = await executeChatTurn(
      {
        id: `${target.id}-consult`,
        agent: 'claude',
        cwd: target.cwd,
        message: params.message,
        sessionId: target.termSessionId,
        permissionMode: 'plan',
        model: null
      },
      () => {}
    )
    return {
      status: result.error ? 502 : 200,
      payload: { ok: !result.error, cell: target.index, type: 'consult', text: result.text, error: result.error }
    }
  } finally {
    delegating.delete(target.id)
  }
}

// Apertura de celdas desde el puente: el main le pide al renderer crear la
// celda y espera el id asignado.
const openRequests = new Map<string, (cellId: string | null) => void>()

function requestOpenCell(spec: {
  agent: 'claude' | 'opencode'
  model: string | null
  cwd: string
}): Promise<string | null> {
  const wc = getWin()?.webContents
  if (!wc || wc.isDestroyed()) return Promise.resolve(null)
  const requestId = randomUUID()
  return new Promise((resolve) => {
    const timer = setTimeout(() => {
      openRequests.delete(requestId)
      resolve(null)
    }, 5000)
    openRequests.set(requestId, (cellId) => {
      clearTimeout(timer)
      openRequests.delete(requestId)
      resolve(cellId)
    })
    wc.send('cells:open-request', { requestId, ...spec })
  })
}

const waitForCellInRegistry = async (cellId: string): Promise<CellInfo | undefined> => {
  for (let i = 0; i < 20; i++) {
    const cell = registry.find((c) => c.id === cellId)
    if (cell) return cell
    await new Promise((r) => setTimeout(r, 150))
  }
  return undefined
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
  getWin = getWindow

  ipcMain.on('cells:sync', (_event, cells: CellInfo[]) => {
    registry = cells
  })

  ipcMain.on('cells:open-response', (_event, { requestId, cellId }: { requestId: string; cellId: string | null }) => {
    openRequests.get(requestId)?.(cellId)
  })

  // Delegación iniciada desde la UI (marcadores @delegate aprobados con clic):
  // el clic del usuario ES el permiso.
  ipcMain.handle(
    'bridge:delegate',
    async (_event, opts: { target: unknown; message: string; fromCellId: string }) => {
      const outcome = await delegateToCell({ ...opts, targetRef: opts.target, skipPermission: true })
      return outcome.payload
    }
  )

  const token = randomUUID()

  const server = createServer(async (req, res) => {
    if (req.headers.authorization !== `Bearer ${token}`) {
      return json(res, 401, { error: 'token inválido' })
    }

    if (req.method === 'GET' && req.url === '/cells') {
      return json(
        res,
        200,
        registry.map((c) => {
          const chatOk = c.mode === 'chat' && c.agent !== null && c.agent !== 'shell'
          const consultOk = c.mode === 'term' && c.agent === 'claude' && c.termSessionId !== null
          return {
            id: c.id,
            index: c.index,
            label: c.label,
            agent: c.agent,
            mode: c.mode,
            cwd: c.cwd,
            model: c.chatModel,
            busy: c.busy || delegating.has(c.id),
            acceptsDelegation: chatOk || consultOk,
            delegationType: chatOk ? 'chat' : consultOk ? 'consult' : null
          }
        })
      )
    }

    if (req.method === 'GET' && req.url === '/activity') {
      const labels = new Map(registry.map((c) => [c.id, `celda ${c.index} (${c.label})`]))
      return json(
        res,
        200,
        getActivity().map((e) => ({
          ts: new Date(e.ts).toISOString(),
          cell: e.cellId ? (labels.get(e.cellId) ?? e.cellId) : null,
          kind: e.kind,
          detail: e.detail
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
      const outcome = await delegateToCell({ targetRef: body.target, message, fromCellId: body.from })
      return json(res, outcome.status, outcome.payload)
    }

    if (req.method === 'POST' && req.url === '/open-cell') {
      let body: { agent?: unknown; model?: unknown; cwd?: unknown; message?: unknown; from?: unknown }
      try {
        body = JSON.parse(await readBody(req))
      } catch {
        return json(res, 400, { error: 'JSON inválido' })
      }
      const agent = body.agent === 'claude' || body.agent === 'opencode' ? body.agent : null
      if (!agent) return json(res, 400, { error: 'agent debe ser "claude" u "opencode"' })
      if (registry.length >= MAX_CELLS) return json(res, 409, { error: 'la grilla está llena (6 celdas)' })

      const fromLabel = fromLabelOf(body.from)
      const fromCell = typeof body.from === 'string' ? findCell(body.from) : undefined
      const model = typeof body.model === 'string' ? body.model : null
      const cwd = typeof body.cwd === 'string' && body.cwd ? body.cwd : (fromCell?.cwd ?? homedir())
      const message = typeof body.message === 'string' ? body.message.trim() : ''

      const ok = await askPermission(
        fromLabel,
        `${fromLabel}→open-cell`,
        `${fromLabel} quiere abrir una celda nueva de chat con ${agent}${model ? ` (${model})` : ''}`,
        `Directorio: ${cwd}${message ? `\n\nY asignarle esta tarea:\n${message.slice(0, 300)}` : ''}`
      )
      if (!ok) return json(res, 403, { error: 'el usuario denegó abrir la celda' })

      const cellId = await requestOpenCell({ agent, model, cwd })
      if (!cellId) return json(res, 502, { error: 'no se pudo crear la celda' })
      const created = await waitForCellInRegistry(cellId)
      if (!created) return json(res, 502, { error: 'la celda no apareció en el registro' })

      if (!message) return json(res, 200, { ok: true, cell: created.index, cellId })

      const outcome = await delegateToCell({
        targetRef: cellId,
        message,
        fromCellId: body.from,
        skipPermission: true
      })
      return json(res, outcome.status, { ...outcome.payload, cellId })
    }

    return json(res, 404, {
      error: 'ruta desconocida: GET /cells, GET /activity, POST /delegate, POST /open-cell'
    })
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

// Skill para Claude Code: enseña a los agentes a usar el puente.
function writeDelegationSkill(): void {
  try {
    const dir = join(homedir(), '.claude', 'skills', 'bridge-cells')
    mkdirSync(dir, { recursive: true })
    writeFileSync(
      join(dir, 'SKILL.md'),
      `---
name: bridge-cells
description: Orquestar los agentes de otras celdas de BridgeEditor — listar celdas, delegarles tareas, consultar terminales de Claude, ver el feed de actividad y abrir celdas nuevas con otro agente/modelo. Usar cuando el usuario pida delegar, coordinar u orquestar trabajo entre tabs/celdas del editor.
---

# Orquestación entre celdas de BridgeEditor

Estás en una celda de BridgeEditor. Con \`$BRIDGE_API\` y \`$BRIDGE_TOKEN\` en tu
entorno puedes orquestar a los agentes de las otras celdas (la tuya es
\`$BRIDGE_CELL_ID\`). Auth siempre: \`-H "Authorization: Bearer $BRIDGE_TOKEN"\`.

## Listar celdas

\`\`\`bash
curl -s "$BRIDGE_API/cells" -H "Authorization: Bearer $BRIDGE_TOKEN"
\`\`\`

\`delegationType\` indica cómo acepta trabajo: \`chat\` (delegación completa,
visible en su celda) o \`consult\` (terminal de Claude: pregunta respondida con
el contexto de SU conversación, sin modificarla).

## Delegar o consultar (bloquea hasta la respuesta; usa --max-time generoso)

\`\`\`bash
curl -s -X POST "$BRIDGE_API/delegate" \\
  -H "Authorization: Bearer $BRIDGE_TOKEN" -H "Content-Type: application/json" \\
  --max-time 900 \\
  -d "{\\"target\\": 2, \\"message\\": \\"<tarea autocontenida>\\", \\"from\\": \\"$BRIDGE_CELL_ID\\"}"
\`\`\`

La respuesta trae \`.text\`. Errores: \`403\` usuario denegó, \`409\` ocupada o no
acepta delegación. Puedes delegar a varias celdas en paralelo (curl en
background) y recoger resultados.

## Abrir una celda nueva con un agente/modelo y asignarle trabajo

\`\`\`bash
curl -s -X POST "$BRIDGE_API/open-cell" \\
  -H "Authorization: Bearer $BRIDGE_TOKEN" -H "Content-Type: application/json" \\
  --max-time 900 \\
  -d "{\\"agent\\": \\"opencode\\", \\"model\\": \\"opencode-go/kimi-k2.6\\", \\"cwd\\": \\"/ruta/proyecto\\", \\"message\\": \\"<primera tarea (opcional)>\\", \\"from\\": \\"$BRIDGE_CELL_ID\\"}"
\`\`\`

## Feed de actividad (qué ha pasado en las demás celdas)

\`\`\`bash
curl -s "$BRIDGE_API/activity" -H "Authorization: Bearer $BRIDGE_TOKEN"
\`\`\`

Últimos eventos: archivos guardados en visores, turnos de chat y delegaciones.

## Marcadores @delegate (en celdas de chat)

Si estás en una celda de chat, puedes proponer delegaciones escribiendo en tu
respuesta: \`@delegate(2, "tarea para la celda 2")\` — el usuario verá un botón
para aprobarla con un clic y el resultado te llegará como un turno nuevo.
`
    )
  } catch {
    // sin permisos para escribir el skill: el puente sigue funcionando vía curl
  }
}
