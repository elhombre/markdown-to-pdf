import { mkdir, readFile, writeFile } from 'node:fs/promises'
import { basename, dirname, extname, resolve } from 'node:path'

import {
  loadConfigStylesheets,
  loadMarkdownPdfConfig,
  PdfRenderer,
  renderMarkdownDocument,
  type Diagnostic,
  type HtmlArtifact,
  type LoadedStylesheet,
  type MarkdownPdfConfig,
} from './core/index.js'

export * from './core/index.js'

export interface RenderMarkdownToPdfInput {
  markdown: string
  title?: string
  baseDir?: string
  config?: MarkdownPdfConfig
  stylesheets?: LoadedStylesheet[]
  renderer?: PdfRenderer
}

export interface RenderMarkdownToPdfResult {
  filteredMarkdown: string
  htmlArtifact: HtmlArtifact
  pdf: Uint8Array
  diagnostics: Diagnostic[]
}

export interface RenderMarkdownFileToPdfInput {
  inputPath: string
  outputPath?: string
  configPath?: string
  saveHtmlPath?: string
  renderer?: PdfRenderer
}

export interface RenderMarkdownFileToPdfResult extends RenderMarkdownToPdfResult {
  outputPath?: string
  saveHtmlPath?: string
}

export async function renderMarkdownToPdf(input: RenderMarkdownToPdfInput): Promise<RenderMarkdownToPdfResult> {
  const rendered = renderMarkdownDocument({
    markdown: input.markdown,
    title: input.title,
    baseDir: input.baseDir,
    config: input.config,
    stylesheets: input.stylesheets,
  })

  const renderer = input.renderer ?? new PdfRenderer()
  try {
    const pdfResult = await renderer.renderHtml({
      html: rendered.htmlArtifact.html,
      pdf: input.config?.pdf,
      pageBreaks: input.config?.pageBreaks,
    })

    return {
      filteredMarkdown: rendered.filteredMarkdown,
      htmlArtifact: rendered.htmlArtifact,
      pdf: pdfResult.buffer,
      diagnostics: [...rendered.diagnostics, ...pdfResult.diagnostics],
    }
  } finally {
    if (!input.renderer) {
      await renderer.close()
    }
  }
}

export async function loadMarkdownPdfConfigWithStylesheets(
  configPath: string,
): Promise<{ config: MarkdownPdfConfig; stylesheets: LoadedStylesheet[]; diagnostics: Diagnostic[] }> {
  const loaded = await loadMarkdownPdfConfig(configPath)
  const stylesheetResult = await loadConfigStylesheets(loaded.config, configPath)

  return {
    config: loaded.config,
    stylesheets: stylesheetResult.stylesheets,
    diagnostics: [...loaded.diagnostics, ...stylesheetResult.diagnostics],
  }
}

export async function renderMarkdownFileToPdf(
  input: RenderMarkdownFileToPdfInput,
): Promise<RenderMarkdownFileToPdfResult> {
  const inputPath = resolve(input.inputPath)
  const markdown = await readFile(inputPath, 'utf8')
  const loaded = input.configPath
    ? await loadMarkdownPdfConfigWithStylesheets(resolve(input.configPath))
    : { config: {}, stylesheets: [], diagnostics: [] }

  const result = await renderMarkdownToPdf({
    markdown,
    title: basename(inputPath, extname(inputPath)),
    baseDir: dirname(inputPath),
    config: loaded.config,
    stylesheets: loaded.stylesheets,
    renderer: input.renderer,
  })

  const diagnostics = [...loaded.diagnostics, ...result.diagnostics]

  if (input.saveHtmlPath) {
    const htmlPath = resolve(input.saveHtmlPath)
    await mkdir(dirname(htmlPath), { recursive: true })
    await writeFile(htmlPath, result.htmlArtifact.html, 'utf8')
  }

  if (input.outputPath) {
    const outputPath = resolve(input.outputPath)
    await mkdir(dirname(outputPath), { recursive: true })
    await writeFile(outputPath, result.pdf)
  }

  return {
    ...result,
    outputPath: input.outputPath ? resolve(input.outputPath) : undefined,
    saveHtmlPath: input.saveHtmlPath ? resolve(input.saveHtmlPath) : undefined,
    diagnostics,
  }
}
