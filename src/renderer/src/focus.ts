// Devolver el teclado a una celda. Cerrar una celda destruye el elemento que
// tenía el foco (el botón ✕, el textarea de xterm) y el navegador lo deja en
// <body>, donde el espacio y las mayúsculas no llegan a ninguna parte. App pide
// el reenfoque (ver closeCell) y cada contenido de celda decide a quién dárselo:
// el que no participe deja la celda muda aunque sea la activa.
import { useEffect, useRef } from 'react'

const FOCUS_CELL_EVENT = 'bridge:focus-cell'

/** Pide que una celda reclame el teclado. */
export function requestCellFocus(cellId: string): void {
  window.dispatchEvent(new CustomEvent(FOCUS_CELL_EVENT, { detail: { cellId } }))
}

/**
 * Atiende esa petición para una celda. `focus` se guarda en un ref para que el
 * listener no dependa de la identidad del callback: se registra una vez por
 * celda y siempre llama a la versión del último render.
 */
export function useFocusOnRequest(cellId: string, focus: () => void): void {
  const focusRef = useRef(focus)
  focusRef.current = focus
  useEffect(() => {
    const onFocusCell = (e: Event): void => {
      const detail = (e as CustomEvent).detail as { cellId?: string } | undefined
      if (detail?.cellId === cellId) focusRef.current()
    }
    window.addEventListener(FOCUS_CELL_EVENT, onFocusCell)
    return () => window.removeEventListener(FOCUS_CELL_EVENT, onFocusCell)
  }, [cellId])
}
