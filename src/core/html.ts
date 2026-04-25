import { existsSync, readFileSync } from 'node:fs'
import { extname, isAbsolute, resolve } from 'node:path'
import { pathToFileURL } from 'node:url'

import MarkdownIt from 'markdown-it'

import type {
  Diagnostic,
  HtmlArtifact,
  LoadedStylesheet,
  PdfConfig,
  RenderMarkdownDocumentInput,
  RenderMarkdownDocumentResult,
  RenderMarkdownToHtmlInput,
  RenderMarkdownToHtmlResult,
} from './types.js'
import { filterMarkdownSections, removeIgnoredFragments } from './sections.js'

const PAGE_BREAK_MARKER = '<!-- pagebreak -->'
const PAGE_BREAK_HTML = '<div class="mdpdf-page-break" aria-hidden="true"></div>'
const DEFAULT_MARGIN = {
  top: '18mm',
  right: '16mm',
  bottom: '20mm',
  left: '16mm',
} as const

function escapeHtml(value: string): string {
  return value.replaceAll('&', '&amp;').replaceAll('<', '&lt;').replaceAll('>', '&gt;').replaceAll('"', '&quot;')
}

function warning(code: string, message: string): Diagnostic {
  return { level: 'warning', code, message }
}

function isFenceStart(line: string): boolean {
  return /^(\s*)(`{3,}|~{3,})/.test(line)
}

function buildDefaultCss(sectionDividersEnabled = true, pdf?: PdfConfig): string {
  const pageFormat = pdf?.format ?? 'A4'
  const marginTop = pdf?.margin?.top ?? DEFAULT_MARGIN.top
  const marginRight = pdf?.margin?.right ?? DEFAULT_MARGIN.right
  const marginBottom = pdf?.margin?.bottom ?? DEFAULT_MARGIN.bottom
  const marginLeft = pdf?.margin?.left ?? DEFAULT_MARGIN.left

  return `
@page {
  size: ${pageFormat};
  margin: ${marginTop} ${marginRight} ${marginBottom} ${marginLeft};
}

html {
  color-scheme: light;
  -webkit-print-color-adjust: exact;
  print-color-adjust: exact;
}

body {
  margin: 0;
  background: #ffffff;
  color: #23201c;
  font-family: 'Inter', 'Segoe UI', sans-serif;
  font-size: 11pt;
  line-height: 1.58;
}

code,
pre {
  font-family: 'JetBrains Mono', 'SFMono-Regular', 'Consolas', monospace;
}

.mdpdf-root {
  box-sizing: border-box;
  width: 100%;
  min-height: 100vh;
  padding: 0;
}

.mdpdf-document {
  box-sizing: border-box;
  width: 100%;
  --mdpdf-section-divider-width: ${sectionDividersEnabled ? '1px' : '0'};
}

.mdpdf-document > :first-child {
  margin-top: 0;
}

.mdpdf-document > :last-child {
  margin-bottom: 0;
}

h1,
h2,
h3,
h4,
h5,
h6 {
  color: #181511;
  font-family: 'Manrope', 'Inter', sans-serif;
  font-weight: 700;
  line-height: 1.18;
  letter-spacing: -0.02em;
  margin: 1.2em 0 0.52em;
}

h1 {
  font-size: 24pt;
}

h2 {
  font-size: 18pt;
  padding-top: 0.35em;
  border-top: var(--mdpdf-section-divider-width) solid #ddd5ca;
}

h3 {
  font-size: 14pt;
}

p,
ul,
ol,
blockquote,
pre,
table {
  margin: 0 0 0.85em;
}

ul,
ol {
  padding-left: 1.35em;
}

li + li {
  margin-top: 0.28em;
}

li > ul,
li > ol {
  margin-top: 0.32em;
}

strong {
  font-weight: 700;
}

em {
  font-style: italic;
}

del {
  color: #5c554d;
}

a {
  color: #315f87;
  text-decoration-thickness: 0.08em;
  text-underline-offset: 0.12em;
}

blockquote {
  padding: 0.2em 0 0.2em 1em;
  border-left: 3px solid #d4cabd;
  color: #453f39;
}

pre,
code {
  font-size: 0.92em;
}

code {
  padding: 0.08em 0.32em;
  border-radius: 0.35em;
  background: #ebe6dd;
}

pre {
  overflow-x: auto;
  padding: 0.9em 1em;
  border: 1px solid #ddd5ca;
  border-radius: 12px;
  background: #faf8f4;
}

pre code {
  padding: 0;
  background: transparent;
  border-radius: 0;
}

hr {
  border: 0;
  border-top: 1px solid #ddd5ca;
  margin: 1.4em 0;
}

table {
  width: 100%;
  border-collapse: collapse;
  font-size: 0.95em;
}

th,
td {
  padding: 0.55em 0.65em;
  border: 1px solid #ddd5ca;
  vertical-align: top;
  text-align: left;
}

th {
  background: #f4efe7;
  font-weight: 700;
}

img {
  max-width: 100%;
}

.mdpdf-page-break {
  break-before: page;
  page-break-before: always;
  height: 0;
  margin: 0;
}

.mdpdf-auto-page-break {
  break-before: page;
  page-break-before: always;
}

.mdpdf-keep-paragraph {
  break-inside: avoid-page;
  page-break-inside: avoid;
}

.mdpdf-keep-with-next {
  break-after: avoid-page;
  page-break-after: avoid;
}

.mdpdf-keep-with-previous {
  break-before: avoid-page;
  page-break-before: avoid;
}
`.trim()
}

function isExternalUrl(value: string): boolean {
  return /^(?:[a-z][a-z\d+.-]*:|\/\/|#)/i.test(value)
}

function resolveAssetUrl(value: string, baseDir?: string): string {
  if (!value || isExternalUrl(value)) {
    return value
  }

  if (!baseDir) {
    return value
  }

  const absolutePath = isAbsolute(value) ? value : resolve(baseDir, value)
  return pathToFileURL(absolutePath).href
}

function getMimeTypeFromPath(path: string): string | undefined {
  switch (extname(path).toLocaleLowerCase()) {
    case '.png':
      return 'image/png'
    case '.jpg':
    case '.jpeg':
      return 'image/jpeg'
    case '.webp':
      return 'image/webp'
    case '.gif':
      return 'image/gif'
    case '.svg':
      return 'image/svg+xml'
    default:
      return undefined
  }
}

function resolveLocalPath(value: string, baseDir?: string): string | undefined {
  if (!value || isExternalUrl(value) || !baseDir) {
    return undefined
  }

  return isAbsolute(value) ? value : resolve(baseDir, value)
}

function resolveImageSrc(value: string, baseDir: string | undefined, diagnostics: Diagnostic[]): string {
  const localPath = resolveLocalPath(value, baseDir)
  if (!localPath) {
    return value
  }

  if (!existsSync(localPath)) {
    diagnostics.push(
      warning('LOCAL_IMAGE_NOT_FOUND', `Local image "${value}" was not found and may not render in the output.`),
    )
    return pathToFileURL(localPath).href
  }

  const mimeType = getMimeTypeFromPath(localPath)
  if (!mimeType) {
    diagnostics.push(
      warning(
        'UNSUPPORTED_IMAGE_EXTENSION',
        `Local image "${value}" uses an unsupported extension and was left as a file URL.`,
      ),
    )
    return pathToFileURL(localPath).href
  }

  const content = readFileSync(localPath)
  return `data:${mimeType};base64,${content.toString('base64')}`
}

function createMarkdownRenderer(baseDir: string | undefined, diagnostics: Diagnostic[]): MarkdownIt {
  const renderer = new MarkdownIt({
    html: true,
    linkify: true,
    typographer: true,
  })

  const defaultImageRule =
    renderer.renderer.rules.image ?? ((tokens, index, options, _env, self) => self.renderToken(tokens, index, options))
  const defaultLinkOpenRule =
    renderer.renderer.rules.link_open ??
    ((tokens, index, options, _env, self) => self.renderToken(tokens, index, options))

  renderer.renderer.rules.image = (tokens, index, options, env, self) => {
    const token = tokens[index]
    if (token) {
      const src = token.attrGet('src')
      if (src) {
        token.attrSet('src', resolveImageSrc(src, baseDir, diagnostics))
      }
    }

    return defaultImageRule(tokens, index, options, env, self)
  }

  renderer.renderer.rules.link_open = (tokens, index, options, env, self) => {
    const token = tokens[index]
    if (token) {
      const href = token.attrGet('href')
      if (href) {
        token.attrSet('href', resolveAssetUrl(href, baseDir))
      }
    }

    return defaultLinkOpenRule(tokens, index, options, env, self)
  }

  return renderer
}

function normalizePageBreaks(markdown: string): { markdown: string; diagnostics: Diagnostic[] } {
  const diagnostics: Diagnostic[] = []
  const lines = markdown.split(/\r?\n/)
  const output: string[] = []
  let hasContent = false
  let previousWasPageBreak = false
  let insideFence = false

  for (const line of lines) {
    if (isFenceStart(line)) {
      insideFence = !insideFence
      output.push(line)
      if (line.trim().length > 0) {
        hasContent = true
      }
      previousWasPageBreak = false
      continue
    }

    if (insideFence) {
      output.push(line)
      if (line.trim().length > 0) {
        hasContent = true
      }
      previousWasPageBreak = false
      continue
    }

    if (line.trim() !== PAGE_BREAK_MARKER) {
      output.push(line)
      if (line.trim().length > 0) {
        hasContent = true
      }
      previousWasPageBreak = false
      continue
    }

    if (!hasContent) {
      diagnostics.push(warning('LEADING_PAGE_BREAK_IGNORED', 'Leading page break marker was ignored.'))
      continue
    }

    if (previousWasPageBreak) {
      diagnostics.push(warning('DUPLICATE_PAGE_BREAK_COLLAPSED', 'Consecutive page break markers were collapsed.'))
      continue
    }

    output.push(PAGE_BREAK_HTML)
    previousWasPageBreak = true
  }

  while (output.length > 0 && output.at(-1)?.trim() === PAGE_BREAK_HTML) {
    output.pop()
    diagnostics.push(warning('TRAILING_PAGE_BREAK_IGNORED', 'Trailing page break marker was ignored.'))
  }

  return {
    markdown: output.join('\n'),
    diagnostics,
  }
}

function buildStylesheetBundle(
  sectionDividersEnabled: boolean,
  pdf: PdfConfig | undefined,
  userStylesheets: LoadedStylesheet[] = [],
): string {
  const baseCss = buildDefaultCss(sectionDividersEnabled, pdf)
  const userCss = userStylesheets.map(stylesheet => `/* ${stylesheet.path} */\n${stylesheet.css.trim()}`).join('\n\n')
  return userCss.length > 0 ? `${baseCss}\n\n${userCss}` : baseCss
}

function buildHtmlDocument(title: string, bodyHtml: string, css: string): HtmlArtifact {
  const html = `<!doctype html>
<html lang="en">
  <head>
    <meta charset="utf-8" />
    <meta name="viewport" content="width=device-width, initial-scale=1" />
    <title>${escapeHtml(title)}</title>
    <style>
${css}
    </style>
  </head>
  <body>
    <main class="mdpdf-root">
      <article class="mdpdf-document">
${bodyHtml}
      </article>
    </main>
  </body>
</html>`

  return { html, css }
}

export function renderMarkdownToHtml(input: RenderMarkdownToHtmlInput): RenderMarkdownToHtmlResult {
  const { markdown, diagnostics } = normalizePageBreaks(input.markdown)
  const markdownRenderer = createMarkdownRenderer(input.baseDir, diagnostics)
  const bodyHtml = markdownRenderer.render(markdown)
  const css = buildStylesheetBundle(input.sectionDividers?.enabled ?? true, input.pdf, input.stylesheets)

  return {
    htmlArtifact: buildHtmlDocument(input.title ?? 'Document', bodyHtml, css),
    diagnostics,
  }
}

export function renderMarkdownDocument(input: RenderMarkdownDocumentInput): RenderMarkdownDocumentResult {
  const omitted = removeIgnoredFragments(input.markdown)
  const filtered = filterMarkdownSections(omitted.markdown, input.config?.sections)
  const rendered = renderMarkdownToHtml({
    markdown: filtered.markdown,
    title: input.title,
    baseDir: input.baseDir,
    pdf: input.config?.pdf,
    sectionDividers: input.config?.sectionDividers,
    stylesheets: input.stylesheets,
  })

  return {
    filteredMarkdown: filtered.markdown,
    htmlArtifact: rendered.htmlArtifact,
    diagnostics: [...omitted.diagnostics, ...filtered.diagnostics, ...rendered.diagnostics],
  }
}
