// Preguntas del agente → opciones clicables.
//
// Dos vías, en este orden:
//  1. Contrato explícito: un bloque ```ask con JSON (ver ASK_CONTRACT en
//     src/main/chat.ts). Sólo claude lo recibe — es el único agente al que se
//     le puede anexar system prompt en headless.
//  2. Heurística sobre la prosa: "(a) … (b) … (c) …" al final de una respuesta
//     que pide elegir. Cubre a opencode y antigravity, y a los turnos en que
//     el modelo se olvida del contrato.
//
// La heurística sólo corre sobre el ÚLTIMO mensaje del turno (ver ChatView):
// una lista enumerada a mitad de camino no es una pregunta.

export interface AskOption {
  /** Lo que se envía al agente al elegirla (y lo que dice el botón). */
  label: string
  /** Texto completo de la opción, como tooltip. */
  detail?: string
}

export interface AskCard {
  question: string | null
  options: AskOption[]
}

const MIN_OPTIONS = 2
const MAX_OPTIONS = 6

const ASK_BLOCK = /```ask[ \t]*\r?\n([\s\S]*?)```/

/** Bloque ```ask con JSON. Devuelve también el texto sin el bloque, que es lo
 * que se renderiza (el JSON crudo no le sirve a nadie). */
function fromBlock(text: string): { ask: AskCard; cleaned: string } | null {
  const match = ASK_BLOCK.exec(text)
  if (!match) return null
  let parsed: unknown
  try {
    parsed = JSON.parse(match[1])
  } catch {
    // JSON mal formado: no ocultamos el bloque — que se vea el error.
    return null
  }
  const raw = parsed as { question?: unknown; options?: unknown }
  if (!Array.isArray(raw.options)) return null
  const options: AskOption[] = []
  for (const item of raw.options) {
    const o = item as { label?: unknown; detail?: unknown }
    const label = typeof o?.label === 'string' ? o.label.trim() : ''
    if (!label) continue
    options.push({
      label: label.slice(0, 120),
      detail: typeof o?.detail === 'string' ? o.detail.trim() : undefined
    })
    if (options.length === MAX_OPTIONS) break
  }
  if (options.length < MIN_OPTIONS) return null
  return {
    ask: {
      question: typeof raw.question === 'string' ? raw.question.trim() : null,
      options
    },
    cleaned: text.replace(ASK_BLOCK, '').trim()
  }
}

// (a) …  ·  **(a)** …  ·  a) …  ·  - (a) …
const ALPHA_MARKER = /^[ \t]*(?:[-*][ \t]*)?(?:\*\*)?\(?([a-fA-F])\)[.:]?(?:\*\*)?[ \t]+(\S.*)$/
// 1. …  ·  1) …  ·  **2)** …
const NUM_MARKER = /^[ \t]*(?:[-*][ \t]*)?(?:\*\*)?([1-6])[.)][.:]?(?:\*\*)?[ \t]+(\S.*)$/

// Señales de que el mensaje está pidiendo elegir, no enumerando pasos. Las
// numeradas exigen una invitación explícita: "1. 2. 3." es casi siempre una
// lista de pasos, y una tarjeta de opciones ahí sería ruido.
const CHOICE_HINT =
  /(?:dime|dime\s+cu[áa]l|decime|elige|eleg[íi]|escoge|escog[ée]|prefieres|prefer[íi]s|quieres que|cu[áa]l (?:de|prefer|opci)|qu[ée] (?:opci[óo]n|camino|prefer)|c[óo]mo (?:quieres|querés|prefieres) (?:seguir|continuar|que)|which (?:one|option)|let me know)/i
const QUESTION_HINT = /[?¿]/

interface Marker {
  line: number
  key: string
  rest: string
}

/** Marcadores consecutivos (a,b,c… o 1,2,3…) desde el primero de la serie. */
function collectMarkers(lines: string[], re: RegExp, alphabet: string[]): Marker[] {
  const found: Marker[] = []
  lines.forEach((line, i) => {
    const m = re.exec(line)
    if (!m) return
    const key = m[1].toLowerCase()
    if (key !== alphabet[found.length]) return
    found.push({ line: i, key, rest: m[2] })
  })
  return found
}

/** Título del botón: lo que va tras el marcador hasta el primer corte fuerte. */
function shortLabel(rest: string): string {
  const clean = rest.replace(/\*\*/g, '').replace(/`/g, '').trim()
  const cut = clean.split(/\s+[—–]\s+|\s+-\s+|[.:;]\s+/)[0].trim()
  const label = cut || clean
  return label.length > 64 ? `${label.slice(0, 63)}…` : label
}

function fromProse(text: string): AskCard | null {
  const lines = text.split('\n')
  const alpha = collectMarkers(lines, ALPHA_MARKER, ['a', 'b', 'c', 'd', 'e', 'f'])
  let markers = alpha
  let numbered = false
  if (markers.length < MIN_OPTIONS) {
    markers = collectMarkers(lines, NUM_MARKER, ['1', '2', '3', '4', '5', '6'])
    numbered = true
  }
  if (markers.length < MIN_OPTIONS || markers.length > MAX_OPTIONS) return null

  const invites = CHOICE_HINT.test(text)
  if (!invites && (numbered || !QUESTION_HINT.test(text))) return null

  const options: AskOption[] = markers.map((marker, i) => {
    const end = i + 1 < markers.length ? markers[i + 1].line : lines.length
    const detail = lines.slice(marker.line, end).join('\n').trim()
    const prefix = numbered ? `${marker.key})` : `(${marker.key})`
    return { label: `${prefix} ${shortLabel(marker.rest)}`, detail }
  })

  // La pregunta suele ser la última línea con contenido antes de la primera
  // opción ("Cómo quieres seguir:").
  let question: string | null = null
  for (let i = markers[0].line - 1; i >= 0; i--) {
    const line = lines[i].replace(/\*\*/g, '').trim()
    if (!line) continue
    if (/[:?¿]/.test(line) && line.length <= 160) question = line
    break
  }
  return { question, options }
}

/** Tarjeta de opciones de una respuesta, si la hay. `cleaned` es el texto a
 * renderizar (sólo cambia cuando se consumió un bloque ```ask). */
export function detectAsk(text: string): { ask: AskCard; cleaned: string } | null {
  if (!text.trim()) return null
  const block = fromBlock(text)
  if (block) return block
  const prose = fromProse(text)
  return prose ? { ask: prose, cleaned: text } : null
}
