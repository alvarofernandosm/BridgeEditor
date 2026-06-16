import { app, dialog, ipcMain, type BrowserWindow } from 'electron'
import { createServer, type IncomingMessage, type ServerResponse } from 'http'
import { randomUUID } from 'crypto'
import { mkdirSync, writeFileSync } from 'fs'
import { join } from 'path'
import { homedir } from 'os'
import { executeChatTurn, executeDelegatedTurn } from './chat'
import { autoCheckpoint } from './checkpoints'
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
  agent: 'claude' | 'opencode' | 'antigravity' | 'shell' | null
  mode: 'term' | 'chat'
  cwd: string
  perm: 'default' | 'flexible' | 'yolo'
  chatSessionId: string | null
  chatModel: string | null
  chatEffort: string | null
  termSessionId: string | null
  busy: boolean
}

let registry: CellInfo[] = []
let getWin: () => BrowserWindow | null = () => null
const delegating = new Set<string>()
/** clave `${origen}→${destino}` → permitir siempre en esta sesión */
const grantedPairs = new Set<string>()
/** último resultado de delegación por celda destino: si el curl del
 * orquestador murió esperando (timeout, red), lo recupera vía GET /result
 * en vez de repetir la tarea. */
const lastResults = new Map<
  string,
  { ts: number; from: string; ok: boolean; type: string; text: string; error: string | null }
>()

const PERM_MAP = { default: 'edits', flexible: 'flexible', yolo: 'full' } as const
const MAX_CELLS = 6

function findCell(target: unknown): CellInfo | undefined {
  if (typeof target === 'number') return registry.find((c) => c.index === target)
  if (typeof target === 'string') {
    const byId = registry.find((c) => c.id === target)
    if (byId) return byId
    // "6", "#6", "celda 6", "cell 6" → número visible en la UI. La forma con
    // guion ("cell-6") es el formato del id interno: NO se interpreta como
    // número, para que un id viejo no caiga en la celda equivocada.
    const m = target.trim().match(/^(?:(?:celda|cell)\s+|#)?(\d+)$/i)
    if (m) return registry.find((c) => c.index === Number(m[1]))
  }
  return undefined
}

const fromLabelOf = (fromCellId: unknown): string => {
  const cell = typeof fromCellId === 'string' ? findCell(fromCellId) : undefined
  return cell ? `La celda ${cell.index} (${cell.label})` : 'Un agente'
}

// Mismo proyecto = mismo directorio o uno contiene al otro. Si los cwd no
// están relacionados, la delegación cruza de proyecto y merece advertencia.
function sameProject(a: string, b: string): boolean {
  if (!a || !b) return true // sin información no alarmamos
  const norm = (p: string): string => (p.length > 1 && p.endsWith('/') ? p.slice(0, -1) : p)
  const x = norm(a)
  const y = norm(b)
  return x === y || x.startsWith(`${y}/`) || y.startsWith(`${x}/`)
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
  /** true → la celda destino arranca sesión nueva (sin su contexto previo). */
  fresh?: boolean
}): Promise<DelegateOutcome> {
  const target = findCell(params.targetRef)
  if (!target) {
    return {
      status: 404,
      payload: {
        error:
          `no existe la celda "${String(params.targetRef)}". Usa el número que ve el usuario ` +
          `(campo "cell" de GET /cells, p. ej. 6) o el id interno exacto (p. ej. "cell-7").`
      }
    }
  }

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

  // Delegación que cruza de proyecto (cwd destino no relacionado con el del
  // origen): el diálogo aparece incluso con "permitir siempre" del par o con
  // aprobación por clic — y con advertencia explícita de rutas.
  const crossProject = fromCell ? !sameProject(fromCell.cwd, target.cwd) : false

  // El nivel de permisos de la celda ORIGEN relaja el diálogo: "sin preguntar"
  // (yolo) nunca pregunta — ni cruzando de proyecto —; "flexible" no pregunta
  // dentro del mismo proyecto. Sin celda origen conocida no hay nivel que
  // aplicar y se pregunta como siempre.
  const originPerm = fromCell?.perm ?? 'default'
  const autoApproved = originPerm === 'yolo' || (originPerm === 'flexible' && !crossProject)

  if (!autoApproved && (!params.skipPermission || crossProject)) {
    const verb = isChatTarget ? 'delegar trabajo en' : 'consultar la conversación de'
    const warn = crossProject
      ? `\n\n⚠️ OJO: la celda ${target.index} trabaja en OTRO proyecto.\n` +
        `Origen:  ${fromCell?.cwd}\nDestino: ${target.cwd}\n` +
        `La tarea se ejecutaría sobre ese otro directorio.`
      : ''
    const pairKey = crossProject
      ? `${fromLabel}→${target.id}:${fromCell?.cwd}→${target.cwd}`
      : `${fromLabel}→${target.id}`
    const ok = await askPermission(
      fromLabel,
      pairKey,
      `${fromLabel} quiere ${verb} la celda ${target.index} (${target.label})${crossProject ? ' — ⚠️ otro proyecto' : ''}`,
      `Directorio: ${target.cwd}\n\nEl agente orquestador podrá enviarle tareas y leer sus respuestas.${warn}`
    )
    if (!ok) return { status: 403, payload: { error: 'el usuario denegó la delegación' } }
  }

  recordActivity({
    cellId: target.id,
    kind: 'delegation',
    detail: `${crossProject ? '⚠ otro proyecto · ' : ''}${autoApproved ? `auto (${originPerm === 'yolo' ? 'sin preguntar' : 'flexible'}) · ` : ''}${fromLabel} → celda ${target.index}: ${params.message.replace(/\s+/g, ' ').slice(0, 100)}`
  })

  delegating.add(target.id)
  try {
    if (isChatTarget) {
      const emit = (payload: unknown): void => {
        const wc = getWin()?.webContents
        if (wc && !wc.isDestroyed()) wc.send(`chat:event:${target.id}`, payload)
      }
      emit({ kind: 'remote-user', text: params.message, from: fromLabel })
      if (params.fresh) emit({ kind: 'done', sessionId: null, meta: 'sesión nueva (delegación fresh)' })
      emit({ kind: 'turn-start' })
      // Herencia de bypass: si la celda ORIGEN está "sin preguntar" (yolo), el
      // turno delegado corre en bypass aunque el destino tenga otro nivel —
      // incluida la celda recién creada por open-cell (que delega con este from).
      // Sin bypass del origen, manda el nivel del destino (que pedirá permiso).
      const permissionMode = originPerm === 'yolo' ? 'full' : (PERM_MAP[target.perm] ?? 'edits')
      // snapshot del workspace antes de un turno delegado (siempre puede editar)
      await autoCheckpoint(target.cwd, `antes de delegación a celda ${target.index}`)
      // Turno con contrato de completitud: si el agente cierra el turno sin
      // terminar la tarea, el puente lo reanuda solo (executeDelegatedTurn).
      const result = await executeDelegatedTurn(
        {
          id: target.id,
          agent: target.agent as 'claude' | 'opencode' | 'antigravity',
          cwd: target.cwd,
          message: params.message,
          sessionId: params.fresh ? null : target.chatSessionId,
          permissionMode,
          model: target.chatModel,
          effort: target.chatEffort
        },
        emit
      )
      lastResults.set(target.id, {
        ts: Date.now(),
        from: fromLabel,
        ok: !result.error,
        type: 'chat',
        text: result.text,
        error: result.error
      })
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
    lastResults.set(target.id, {
      ts: Date.now(),
      from: fromLabel,
      ok: !result.error,
      type: 'consult',
      text: result.text,
      error: result.error
    })
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
  agent: 'claude' | 'opencode' | 'antigravity'
  model: string | null
  effort: string | null
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
            cell: c.index,
            id: c.id,
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

    if (req.method === 'GET' && req.url?.startsWith('/result')) {
      const ref = new URL(req.url, 'http://localhost').searchParams.get('cell') ?? ''
      const cell = findCell(ref)
      if (!cell) return json(res, 404, { error: `no existe la celda "${ref}"` })
      if (delegating.has(cell.id) || cell.busy) {
        return json(res, 409, { error: `la celda ${cell.index} aún está trabajando; reintenta` })
      }
      const r = lastResults.get(cell.id)
      if (!r) {
        return json(res, 404, {
          error: `la celda ${cell.index} no tiene resultados de delegación en esta sesión`
        })
      }
      return json(res, 200, {
        cell: cell.index,
        ts: new Date(r.ts).toISOString(),
        from: r.from,
        ok: r.ok,
        type: r.type,
        text: r.text,
        error: r.error
      })
    }

    if (req.method === 'POST' && req.url === '/delegate') {
      let body: { target?: unknown; message?: unknown; from?: unknown; fresh?: unknown }
      try {
        body = JSON.parse(await readBody(req))
      } catch {
        return json(res, 400, { error: 'JSON inválido' })
      }
      const message = typeof body.message === 'string' ? body.message.trim() : ''
      if (!message) return json(res, 400, { error: 'falta "message"' })
      const outcome = await delegateToCell({
        targetRef: body.target,
        message,
        fromCellId: body.from,
        fresh: body.fresh === true
      })
      return json(res, outcome.status, outcome.payload)
    }

    if (req.method === 'POST' && req.url === '/open-cell') {
      let body: {
        agent?: unknown
        model?: unknown
        effort?: unknown
        cwd?: unknown
        message?: unknown
        from?: unknown
      }
      try {
        body = JSON.parse(await readBody(req))
      } catch {
        return json(res, 400, { error: 'JSON inválido' })
      }
      const agent =
        body.agent === 'claude' || body.agent === 'opencode' || body.agent === 'antigravity'
          ? body.agent
          : null
      if (!agent) {
        return json(res, 400, { error: 'agent debe ser "claude", "opencode" o "antigravity"' })
      }
      if (registry.length >= MAX_CELLS) return json(res, 409, { error: 'la grilla está llena (6 celdas)' })

      const fromLabel = fromLabelOf(body.from)
      const fromCell = typeof body.from === 'string' ? findCell(body.from) : undefined
      const model = typeof body.model === 'string' ? body.model : null
      const effort = typeof body.effort === 'string' ? body.effort : null
      const cwd = typeof body.cwd === 'string' && body.cwd ? body.cwd : (fromCell?.cwd ?? homedir())
      const message = typeof body.message === 'string' ? body.message.trim() : ''

      // Solo "sin preguntar" (yolo) en la celda origen se salta este diálogo;
      // "flexible" sí pregunta: abrir celdas es más invasivo que delegar.
      if (fromCell?.perm !== 'yolo') {
        const ok = await askPermission(
          fromLabel,
          `${fromLabel}→open-cell`,
          `${fromLabel} quiere abrir una celda nueva de chat con ${agent}` +
            `${model ? ` (${model}${effort ? `, effort ${effort}` : ''})` : effort ? ` (effort ${effort})` : ''}`,
          `Directorio: ${cwd}${message ? `\n\nY asignarle esta tarea:\n${message.slice(0, 300)}` : ''}`
        )
        if (!ok) return json(res, 403, { error: 'el usuario denegó abrir la celda' })
      }

      const cellId = await requestOpenCell({ agent, model, effort, cwd })
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
      error:
        'ruta desconocida: GET /cells, GET /activity, GET /result?cell=N, POST /delegate, POST /open-cell'
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

// Skill para los agentes: enseña a usar el puente. Se escribe donde la lee
// cada CLI: ~/.claude/skills (Claude Code, y OpenCode es compatible) y como
// plugin de Antigravity (~/.gemini/config/plugins/<n>/skills/<n>/SKILL.md).
function writeDelegationSkill(): void {
  const skill = `---
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

Cada celda trae DOS identificadores — no los confundas:

- \`cell\` (número 1–6): la posición que VE EL USUARIO en la grilla. Cuando el
  usuario dice "la celda 6", es esto. Úsalo como \`target\` (sin preguntar).
  Cambia si el usuario reordena las celdas.
- \`id\` (p. ej. \`"cell-7"\`): identificador interno estable; NO es la posición
  (el contador nunca se reusa). Úsalo como \`target\` solo en tareas largas,
  porque sobrevive a reordenamientos.

\`delegationType\` indica cómo acepta trabajo: \`chat\` (delegación completa,
visible en su celda) o \`consult\` (terminal de Claude: pregunta respondida con
el contexto de SU conversación, sin modificarla).

## Delegar o consultar (bloquea hasta la respuesta; usa --max-time generoso)

\`\`\`bash
curl -s -X POST "$BRIDGE_API/delegate" \\
  -H "Authorization: Bearer $BRIDGE_TOKEN" -H "Content-Type: application/json" \\
  --max-time 3600 \\
  -d "{\\"target\\": 2, \\"message\\": \\"<tarea autocontenida>\\", \\"from\\": \\"$BRIDGE_CELL_ID\\"}"
\`\`\`

Las tareas grandes toman DECENAS de minutos: nunca uses un --max-time menor a
3600. Si tu curl muere esperando (timeout o red), el turno SIGUE corriendo en
la celda destino y su resultado NO se pierde: espera, consulta GET /activity
y recupera la respuesta terminada con:

\`\`\`bash
curl -s "$BRIDGE_API/result?cell=2" -H "Authorization: Bearer $BRIDGE_TOKEN"
\`\`\`

(409 = aún trabajando; 200 = última respuesta completa, con \`.ts\` para saber
de cuándo es). NO repitas la delegación a ciegas: duplicarías el trabajo.

\`target\` acepta el número de celda que usa el usuario (\`2\`, \`"celda 2"\` y
\`"cell 2"\` también valen) o un id interno exacto (\`"cell-7"\`). Si el usuario
dice "delega a la celda 6", el target es \`6\` — no necesitas confirmar.

La respuesta trae \`.text\`. Errores: \`403\` usuario denegó, \`409\` ocupada o no
acepta delegación, \`404\` celda inexistente. Puedes delegar a varias celdas en
paralelo (curl en background) y recoger resultados.

El puente le exige al agente delegado cerrar con un marcador de completitud
(\`<task_end>\`, oculto para el usuario) y reanuda automáticamente los turnos
que terminan sin él (hasta 2 continuaciones): \`.text\` corresponde al trabajo
terminado y las continuaciones quedan registradas en el feed de actividad.

Si la celda destino trabaja en un directorio NO relacionado con el tuyo
(otro proyecto), el usuario verá un diálogo de advertencia. Prefiere celdas
del mismo proyecto; para trabajar en otro proyecto es mejor abrir una celda
nueva con el \`cwd\` correcto (/open-cell) o avisarle al usuario.

Que aparezca diálogo de permiso depende del nivel de permisos de TU celda
(lo eligió el usuario al lanzarla): con "sin preguntar" ninguna comunicación
entre celdas pide permiso (tampoco /open-cell); con "flexible" delegar dentro
del mismo proyecto no pregunta (cruzar de proyecto y /open-cell sí); con
"preguntar todo" siempre hay diálogo. En todos los casos un \`403\` significa
que el usuario denegó.

Las celdas de chat ejecutan TURNOS HEADLESS: el proceso del agente muere al
terminar cada turno. Pide tareas que terminen dentro del turno y desconfía de
respuestas tipo "sigo trabajando en segundo plano" — ese trabajo no existe ya.
Si la tarea es grande, divídela en delegaciones sucesivas. Tampoco hay TTY:
al delegar, indica usar banderas no interactivas (--yes/--force) porque las
preguntas y/N de las herramientas abortan solas.

Coordina SIN ruido: cada delegación cuesta un turno completo de la celda.
Si una tarea quedó bloqueada y se desbloqueó (p. ej. git stash hecho), manda
UNA sola delegación que diga qué cambió y qué hacer ahora — no repitas
mensajes de estado ni preguntes "¿cómo vas?" (usa GET /activity para eso).
La celda no comparte tu contexto: cada mensaje debe ser autocontenido.

Por defecto la celda destino CONTINÚA su conversación (recuerda lo anterior).
Para una tarea independiente que no necesita ese contexto, agrega
\`"fresh": true\` al body: la celda arranca sesión nueva (contexto limpio).

## Abrir una celda nueva con un agente/modelo y asignarle trabajo

ANTES de abrir: si el usuario NO especificó agente, modelo o effort, PREGÚNTALE
qué quiere (¿claude u opencode? ¿qué modelo? ¿qué nivel de razonamiento?) en
lugar de decidir por él. En particular NO abras por defecto un clon de tu mismo
modelo: el valor del multi-agente está en combinar modelos distintos. Solo
procede sin preguntar si el usuario ya lo dijo o te pidió explícitamente que
elijas tú.

\`\`\`bash
curl -s -X POST "$BRIDGE_API/open-cell" \\
  -H "Authorization: Bearer $BRIDGE_TOKEN" -H "Content-Type: application/json" \\
  --max-time 3600 \\
  -d "{\\"agent\\": \\"opencode\\", \\"model\\": \\"opencode-go/kimi-k2.6\\", \\"effort\\": \\"high\\", \\"cwd\\": \\"/ruta/proyecto\\", \\"message\\": \\"<primera tarea (opcional)>\\", \\"from\\": \\"$BRIDGE_CELL_ID\\"}"
\`\`\`

\`agent\` puede ser \`claude\`, \`opencode\` o \`antigravity\` (CLI \`agy\`: Gemini,
Claude y GPT vía Antigravity). \`effort\` es opcional (nivel de razonamiento):
para claude \`low|medium|high|xhigh|max\`; para opencode es el variant del
proveedor (\`minimal|high|max\`…); antigravity NO usa effort aparte — va dentro
del nombre del modelo (p. ej. \`"Gemini 3.5 Flash (High)"\`). Los modelos se
listan con \`opencode models\` / \`agy models\`; los de claude son sus alias
(\`fable\`, \`opus\`, \`sonnet\`, \`haiku\`).

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

  try {
    const dir = join(homedir(), '.claude', 'skills', 'bridge-cells')
    mkdirSync(dir, { recursive: true })
    writeFileSync(join(dir, 'SKILL.md'), skill)
  } catch {
    // sin permisos para escribir el skill: el puente sigue funcionando vía curl
  }

  try {
    const pluginDir = join(homedir(), '.gemini', 'config', 'plugins', 'bridge-cells')
    const skillDir = join(pluginDir, 'skills', 'bridge-cells')
    mkdirSync(skillDir, { recursive: true })
    writeFileSync(
      join(pluginDir, 'plugin.json'),
      JSON.stringify(
        {
          name: 'bridge-cells',
          version: app.getVersion(),
          description: 'Orquestación entre celdas de BridgeEditor',
          author: { name: 'BridgeEditor' }
        },
        null,
        2
      )
    )
    writeFileSync(join(skillDir, 'SKILL.md'), skill)
  } catch {
    // antigravity no instalado o sin permisos: claude/opencode siguen con su copia
  }
}
