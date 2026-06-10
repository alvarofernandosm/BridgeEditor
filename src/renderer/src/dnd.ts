/** Tipo MIME del drag de celdas: distingue reordenar celdas de soltar archivos. */
export const CELL_MIME = 'application/x-bridge-cell'

/**
 * Extrae las rutas locales de un drop de archivos. En Linux (Wayland/GTK)
 * `dataTransfer.files` a veces llega vacío o solo con el primer archivo
 * cuando se arrastran varios o en drops consecutivos; text/uri-list sí trae
 * la lista completa, así que se usan ambas fuentes y se deduplica.
 */
export function pathsFromDrop(dt: DataTransfer): string[] {
  const paths: string[] = []
  for (const file of Array.from(dt.files)) {
    try {
      const p = window.bridge.filePathFor(file)
      if (p) paths.push(p)
    } catch {
      // archivo sin ruta local resoluble (p. ej. arrastrado desde otra app)
    }
  }
  for (const line of (dt.getData('text/uri-list') || '').split(/\r?\n/)) {
    const uri = line.trim()
    if (!uri || uri.startsWith('#') || !uri.startsWith('file://')) continue
    try {
      const p = decodeURIComponent(new URL(uri).pathname)
      if (p && !paths.includes(p)) paths.push(p)
    } catch {
      // URI malformada: ignorar
    }
  }
  try {
    window.bridge.dndDebug({
      types: Array.from(dt.types),
      files: dt.files.length,
      uriList: dt.getData('text/uri-list'),
      extracted: paths
    })
  } catch {
    // el diagnóstico nunca rompe el drop
  }
  return paths
}

/** Une rutas citando las que llevan caracteres especiales para el shell. */
export function quotePaths(paths: string[]): string {
  return paths
    .map((p) => (/[^\w@%+=:,./-]/.test(p) ? `'${p.replace(/'/g, "'\\''")}'` : p))
    .join(' ')
}
