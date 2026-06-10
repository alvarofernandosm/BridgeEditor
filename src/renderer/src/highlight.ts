// Resaltado de sintaxis compartido entre el visor de código y el Markdown.
// Se usa el subconjunto "common" de highlight.js (~35 lenguajes) para no
// inflar el bundle; dockerfile se registra aparte porque no viene incluido.
import hljs from 'highlight.js/lib/common'
import dockerfile from 'highlight.js/lib/languages/dockerfile'
import { Marked } from 'marked'
import 'highlight.js/styles/github-dark.css'

hljs.registerLanguage('dockerfile', dockerfile)

const MAX_HIGHLIGHT_BYTES = 300_000

const EXT_LANG: Record<string, string> = {
  ts: 'typescript',
  tsx: 'typescript',
  mts: 'typescript',
  js: 'javascript',
  jsx: 'javascript',
  mjs: 'javascript',
  cjs: 'javascript',
  py: 'python',
  rb: 'ruby',
  sh: 'bash',
  bash: 'bash',
  zsh: 'bash',
  json: 'json',
  yml: 'yaml',
  yaml: 'yaml',
  css: 'css',
  scss: 'scss',
  less: 'less',
  html: 'xml',
  htm: 'xml',
  xml: 'xml',
  svg: 'xml',
  c: 'c',
  h: 'c',
  cpp: 'cpp',
  hpp: 'cpp',
  cc: 'cpp',
  cs: 'csharp',
  rs: 'rust',
  go: 'go',
  java: 'java',
  kt: 'kotlin',
  php: 'php',
  sql: 'sql',
  swift: 'swift',
  lua: 'lua',
  pl: 'perl',
  r: 'r',
  toml: 'ini',
  ini: 'ini',
  conf: 'ini',
  diff: 'diff',
  patch: 'diff',
  graphql: 'graphql',
  mk: 'makefile'
}

export function languageForPath(path: string): string | null {
  const name = (path.split(/[\\/]/).pop() ?? '').toLowerCase()
  if (name === 'dockerfile' || name.startsWith('dockerfile.')) return 'dockerfile'
  if (name === 'makefile') return 'makefile'
  const ext = name.includes('.') ? name.split('.').pop()! : ''
  return EXT_LANG[ext] ?? null
}

/** Devuelve HTML resaltado, o null si no hay lenguaje o el archivo es muy grande. */
export function highlightCode(text: string, language: string | null): string | null {
  if (!language || text.length > MAX_HIGHLIGHT_BYTES) return null
  try {
    return hljs.highlight(text, { language }).value
  } catch {
    return null
  }
}

const escapeHtml = (s: string): string =>
  s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;')

const md = new Marked({ gfm: true })

md.use({
  renderer: {
    code({ text, lang }: { text: string; lang?: string }): string {
      const language = lang && hljs.getLanguage(lang) ? lang : null
      const inner =
        language && text.length <= MAX_HIGHLIGHT_BYTES
          ? hljs.highlight(text, { language }).value
          : escapeHtml(text)
      const badge = language ? `<span class="code-lang">${language}</span>` : ''
      return (
        `<div class="code-block">${badge}` +
        `<button class="copy-btn" data-copy type="button">⧉ copiar</button>` +
        `<pre><code class="hljs">${inner}</code></pre></div>`
      )
    }
  }
})

export function renderMarkdown(src: string): string {
  return md.parse(src, { async: false }) as string
}
