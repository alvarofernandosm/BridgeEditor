// Estado compartido del puente de delegación (evita ciclos de import entre
// bridge.ts y pty.ts/chat.ts, que inyectan estas variables a los agentes).
let env: Record<string, string> = {}

export function setBridgeEnv(next: Record<string, string>): void {
  env = next
}

export function bridgeEnv(): Record<string, string> {
  return env
}

// Feed de actividad entre celdas: ring buffer que los agentes consultan por
// pull (GET /activity) — los agentes headless no pueden sostener streams SSE.
export interface ActivityEntry {
  ts: number
  cellId: string | null
  kind: 'file-saved' | 'chat-turn' | 'delegation'
  detail: string
}

const activity: ActivityEntry[] = []

export function recordActivity(entry: Omit<ActivityEntry, 'ts'>): void {
  activity.push({ ...entry, ts: Date.now() })
  if (activity.length > 200) activity.splice(0, activity.length - 200)
}

export function getActivity(limit = 50): ActivityEntry[] {
  return activity.slice(-limit)
}
