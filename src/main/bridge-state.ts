// Estado compartido del puente de delegación (evita ciclos de import entre
// bridge.ts y pty.ts/chat.ts, que inyectan estas variables a los agentes).
let env: Record<string, string> = {}

export function setBridgeEnv(next: Record<string, string>): void {
  env = next
}

export function bridgeEnv(): Record<string, string> {
  return env
}
