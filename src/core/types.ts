export interface Diagnostic {
  level: 'error' | 'warning'
  code: string
  message: string
  source?: string
}

export interface SectionFilterConfig {
  mode: 'include' | 'exclude'
  headings: string[]
}

export interface PdfMarginConfig {
  top?: string
  right?: string
  bottom?: string
  left?: string
}

export interface PdfConfig {
  format?: 'A4' | 'Letter'
  margin?: PdfMarginConfig
}

export interface PageBreakConfig {
  mode?: 'manual' | 'auto-sections'
  headingLevel?: 1 | 2 | 3 | 4 | 5 | 6
  minRemainingPageHeight?: string
  keepHeadingWithNext?: boolean
  avoidParagraphSplit?: boolean
  maxUnbreakableParagraphHeight?: string
  keepPreambleWithList?: boolean
}

export interface SectionDividerConfig {
  enabled?: boolean
}

export interface MarkdownPdfConfig {
  sections?: SectionFilterConfig
  stylesheets?: string[]
  pdf?: PdfConfig
  pageBreaks?: PageBreakConfig
  sectionDividers?: SectionDividerConfig
}

export interface LoadedStylesheet {
  path: string
  css: string
}

export interface HtmlArtifact {
  html: string
  css: string
}

export interface FilteredMarkdownResult {
  markdown: string
  diagnostics: Diagnostic[]
}

export interface RenderMarkdownToHtmlInput {
  markdown: string
  title?: string
  baseDir?: string
  pdf?: PdfConfig
  sectionDividers?: SectionDividerConfig
  stylesheets?: LoadedStylesheet[]
}

export interface RenderMarkdownToHtmlResult {
  htmlArtifact: HtmlArtifact
  diagnostics: Diagnostic[]
}

export interface RenderPdfInput {
  html: string
  pdf?: PdfConfig
  pageBreaks?: PageBreakConfig
}

export interface RenderPdfResult {
  buffer: Uint8Array
  diagnostics: Diagnostic[]
}

export interface RenderMarkdownDocumentInput {
  markdown: string
  title?: string
  baseDir?: string
  config?: MarkdownPdfConfig
  stylesheets?: LoadedStylesheet[]
}

export interface RenderMarkdownDocumentResult {
  filteredMarkdown: string
  htmlArtifact: HtmlArtifact
  diagnostics: Diagnostic[]
}
