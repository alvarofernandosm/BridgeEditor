// Título automático de una celda: en qué anda el agente, sin costo ni latencia.
//   term → el título OSC que el propio TUI publica (Claude Code escribe ahí la
//          tarea en curso); el shell también publica el suyo, y ese se descarta.
//   chat → el primer mensaje del usuario de la sesión, resumido a una línea.
// El usuario siempre puede sobreescribirlo (CellState.title gana sobre autoTitle).

/** Títulos que solo nombran el proceso o la carpeta: no dicen nada de la tarea. */
const GENERIC_TITLE =
  /^(bash|zsh|fish|sh|dash|ksh|tcsh|powershell|pwsh|cmd|command prompt|windows powershell|terminal|konsole|node|npm|claude|claude code|opencode|agy|antigravity)$/i

const MAX_TITLE = 80

/**
 * Normaliza un título OSC 0/2 de la terminal, o devuelve null si no aporta
 * (prompt del shell, ruta, nombre del binario). Devolver null deja en pie el
 * último título bueno: al terminar, los TUI restauran el título del shell y si
 * no se filtrara, cada tarea se borraría justo al completarse.
 */
export function cleanTerminalTitle(raw: string, cwd: string): string | null {
  const t = raw.replace(/\p{Cc}/gu, '').trim()
  if (!t) return null
  if (/^[\w.-]+@[\w.-]+[: ]/.test(t)) return null // user@host:/ruta
  if (/^(~|\/|[A-Za-z]:[\\/]|\\\\)/.test(t)) return null // ruta absoluta
  if (cwd && (t === cwd || t.endsWith(cwd))) return null
  // "✳ Refactorizando el grid", "● claude" → fuera el indicador de estado
  const body = t.replace(/^[^\p{L}\p{N}]+/u, '').trim()
  if (!body || GENERIC_TITLE.test(body)) return null
  const base = cwd.split(/[\\/]/).filter(Boolean).pop()
  if (base && body.toLowerCase() === base.toLowerCase()) return null
  return truncate(body, MAX_TITLE)
}

const MAX_PROMPT_TITLE = 60

/**
 * Título a partir del primer mensaje de un chat: primera oración, sin código
 * ni saltos de línea. null para los slash commands y los mensajes vacíos.
 */
export function titleFromPrompt(message: string): string | null {
  const flat = message
    .replace(/```[\s\S]*?```/g, ' ') // bloques de código
    .replace(/^\s*\[[^\]]{3,120}\]\s*/, '') // prefijos del puente ([Resultado de…])
    .replace(/\s+/g, ' ')
    .trim()
  if (!flat || flat.startsWith('/')) return null
  const text = truncate(firstRealSentence(flat), MAX_PROMPT_TITLE).replace(/[\s:;,–—-]+$/, '')
  if (!text) return null
  return text.charAt(0).toUpperCase() + text.slice(1)
}

/** Primera oración que dice algo: los saludos y acuses cortos ("Hola.", "Ok.")
 * se saltan en vez de comerse el título. */
function firstRealSentence(flat: string): string {
  const MIN_SENTENCE = 12
  let start = 0
  for (const m of flat.matchAll(/[.!?…](?=\s|$)/g)) {
    const end = m.index ?? 0
    if (end - start >= MIN_SENTENCE) return flat.slice(start, end).trim()
    start = end + 1
  }
  return flat.slice(start).trim()
}

function truncate(text: string, max: number): string {
  if (text.length <= max) return text
  const cut = text.lastIndexOf(' ', max)
  return text.slice(0, cut > max / 2 ? cut : max).trimEnd() + '…'
}
