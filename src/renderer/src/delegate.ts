// Marcadores @delegate(N, "tarea") que el agente escribe en su respuesta para
// proponerle al usuario delegar trabajo a otra celda.
//
// Detectarlos a secas no sirve: la propia skill documenta la sintaxis entre
// backticks, así que cualquier agente que EXPLIQUE el puente —o que le dé
// feedback sobre él— disparaba propuestas fantasma. Lo que está dentro de
// código es cita, no intención.

export interface Delegation {
  /** Celda destino tal como la escribió el agente: número visible, id o nombre. */
  target: string
  task: string
}

export interface ParsedDelegations {
  proposals: Delegation[]
  /** Marcadores que apuntan a la propia celda: no son delegables (el puente los
   *  rechaza con "no puedes delegarte a ti mismo") y no deben ofrecerse. */
  selfTargets: string[]
}

// El marcador vale sólo al principio de su línea (se toleran sangría y viñetas).
// Citarlo a mitad de una frase es explicarlo, no pedirlo: un agente que
// documenta el puente —o que te da feedback sobre él— no quiere delegar nada.
// La skill lo pide así de explícito, y el modo de fallo de exigirlo es mucho
// más benigno: un botón que no aparece se vuelve a pedir; una delegación
// fantasma gasta un turno entero y ensucia la conversación de otra celda.
const DELEGATE_RE = /^[ \t]*(?:[-*>]\s*)?@delegate\(\s*([\w-]+)\s*,\s*"([^"]{3,500})"\s*\)/gm

/**
 * Quita los tramos de código antes de buscar marcadores. El bloque sin cerrar
 * cuenta como código hasta el final: un turno cortado a mitad de un ejemplo no
 * debe convertir el ejemplo en una propuesta.
 */
function withoutCode(text: string): string {
  return text
    .replace(/```[\s\S]*?```/g, ' ')
    .replace(/```[\s\S]*$/, ' ')
    .replace(/~~~[\s\S]*?~~~/g, ' ')
    .replace(/~~~[\s\S]*$/, ' ')
    .replace(/`[^`\n]*`/g, ' ')
}

/**
 * Propuestas de delegación de una respuesta del agente. `self` es la celda que
 * habla: el número que ve el usuario y su id interno, para no ofrecer un
 * marcador que se dirige a sí misma.
 */
export function parseDelegations(
  text: string,
  self: { index: number; cellId: string }
): ParsedDelegations {
  const proposals: Delegation[] = []
  const selfTargets: string[] = []
  const prose = withoutCode(text)
  DELEGATE_RE.lastIndex = 0
  let m: RegExpExecArray | null
  while ((m = DELEGATE_RE.exec(prose))) {
    const target = m[1]
    if (target === String(self.index) || target === self.cellId) selfTargets.push(target)
    else proposals.push({ target, task: m[2] })
  }
  return { proposals, selfTargets }
}
