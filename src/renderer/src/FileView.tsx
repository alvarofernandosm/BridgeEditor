import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { highlightCode, languageForPath, renderMarkdown } from './highlight'

const isMarkdown = (path: string): boolean => /\.(md|markdown)$/i.test(path)

interface FileViewProps {
  cellId: string
  path: string
}

export function FileView({ cellId, path }: FileViewProps): JSX.Element {
  const [content, setContent] = useState<string | null>(null)
  const [draft, setDraft] = useState('')
  const [mode, setMode] = useState<'preview' | 'edit'>('preview')
  const [dirty, setDirty] = useState(false)
  const [externalChange, setExternalChange] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const textareaRef = useRef<HTMLTextAreaElement>(null)
  const dirtyRef = useRef(dirty)
  dirtyRef.current = dirty

  const load = useCallback(async (): Promise<void> => {
    try {
      const text = await window.bridge.readFile(path)
      setContent(text)
      setError(null)
      if (!dirtyRef.current) setDraft(text)
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e))
    }
  }, [path])

  useEffect(() => {
    setContent(null)
    setDraft('')
    setDirty(false)
    setExternalChange(false)
    setMode('preview')
    load()
    // Recarga en vivo: si un agente (u otro editor) modifica el archivo y no hay
    // cambios locales sin guardar, la vista se actualiza sola.
    return window.bridge.watchFile(cellId, path, () => {
      if (dirtyRef.current) setExternalChange(true)
      else load()
    })
  }, [cellId, path, load])

  const save = useCallback(async (): Promise<void> => {
    try {
      await window.bridge.writeFile(path, draft)
      setContent(draft)
      setDirty(false)
      setExternalChange(false)
      setError(null)
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e))
    }
  }, [path, draft])

  const insertComment = (): void => {
    const ta = textareaRef.current
    const pos = ta?.selectionStart ?? draft.length
    const stamp = new Date().toISOString().slice(0, 10)
    const snippet = `\n> 💬 **Comentario (${stamp}):** \n`
    setDraft(draft.slice(0, pos) + snippet + draft.slice(pos))
    setDirty(true)
    requestAnimationFrame(() => {
      if (!ta) return
      ta.focus()
      const cursor = pos + snippet.length - 1
      ta.setSelectionRange(cursor, cursor)
    })
  }

  const onPreviewClick = (e: React.MouseEvent): void => {
    const target = e.target as HTMLElement
    const copyBtn = target.closest('[data-copy]') as HTMLButtonElement | null
    if (copyBtn) {
      const code = copyBtn.parentElement?.querySelector('code')?.textContent ?? ''
      navigator.clipboard.writeText(code)
      const original = copyBtn.textContent
      copyBtn.textContent = '✓ copiado'
      setTimeout(() => {
        copyBtn.textContent = original
      }, 1200)
      return
    }
    const anchor = target.closest('a')
    if (anchor?.href) {
      e.preventDefault()
      if (/^https?:/.test(anchor.href)) window.open(anchor.href)
    }
  }

  if (error && content === null) {
    return (
      <div className="file-error">
        <p>No se pudo abrir el archivo</p>
        <code>{error}</code>
      </div>
    )
  }

  if (content === null) {
    return <div className="file-loading">Cargando…</div>
  }

  return (
    <div className="file-view">
      <div className="file-toolbar">
        <button
          className={`tab-btn ${mode === 'preview' ? 'tab-active' : ''}`}
          onClick={() => setMode('preview')}
        >
          👁 Vista
        </button>
        <button
          className={`tab-btn ${mode === 'edit' ? 'tab-active' : ''}`}
          onClick={() => setMode('edit')}
        >
          ✏️ Editar
        </button>
        {mode === 'edit' && (
          <button className="tab-btn" onClick={insertComment} title="Insertar comentario en el cursor">
            💬 Comentario
          </button>
        )}
        <div className="spacer" />
        <span className="file-lang">
          {isMarkdown(path) ? 'markdown' : (languageForPath(path) ?? 'texto')}
        </span>
        {externalChange && (
          <span className="file-warn" title="El archivo cambió en disco mientras editabas">
            ⚠ cambió en disco
          </span>
        )}
        {error && <span className="file-warn">⚠ {error}</span>}
        {dirty && <span className="file-dirty">● sin guardar</span>}
        {dirty && (
          <button className="save-btn" onClick={save} title="Guardar (Ctrl+S)">
            💾 Guardar
          </button>
        )}
      </div>
      {mode === 'preview' ? (
        isMarkdown(path) ? (
          <div
            className="file-body md-body"
            onClick={onPreviewClick}
            dangerouslySetInnerHTML={{ __html: renderMarkdown(dirty ? draft : content) }}
          />
        ) : (
          <CodeBody path={path} text={dirty ? draft : content} />
        )
      ) : (
        <textarea
          ref={textareaRef}
          className="file-editor"
          value={draft}
          spellCheck={false}
          onChange={(e) => {
            setDraft(e.target.value)
            setDirty(true)
          }}
          onKeyDown={(e) => {
            if ((e.ctrlKey || e.metaKey) && e.key.toLowerCase() === 's') {
              e.preventDefault()
              save()
            }
          }}
        />
      )}
    </div>
  )
}

function CodeBody({ path, text }: { path: string; text: string }): JSX.Element {
  const language = languageForPath(path)
  const html = useMemo(() => highlightCode(text, language), [text, language])

  if (html === null) {
    return <pre className="file-body file-plain">{text}</pre>
  }

  const lineCount = text.replace(/\n$/, '').split('\n').length
  return (
    <div className="file-body code-view">
      <div className="line-gutter" aria-hidden="true">
        {Array.from({ length: lineCount }, (_, i) => (
          <span key={i}>{i + 1}</span>
        ))}
      </div>
      <pre className="code-pre">
        <code className="hljs" dangerouslySetInnerHTML={{ __html: html }} />
      </pre>
    </div>
  )
}
