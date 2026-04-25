import { existsSync } from 'node:fs'
import { mkdir, readFile, readdir, writeFile } from 'node:fs/promises'
import { basename, dirname, extname, relative, resolve } from 'node:path'

import {
  loadConfigStylesheets,
  loadMarkdownPdfConfig,
  PdfRenderer,
  renderMarkdownDocument,
  type Diagnostic,
  type LoadedStylesheet,
  type MarkdownPdfConfig,
} from '../core/index.js'

interface CliOptions {
  command: string
  input?: string
  output?: string
  inputDir?: string
  outputDir?: string
  config?: string
  saveHtml: boolean
  quiet: boolean
}

interface ResolvedConfig {
  config: MarkdownPdfConfig
  stylesheets: LoadedStylesheet[]
  diagnostics: Diagnostic[]
}

interface RenderJob {
  inputPath: string
  outputPdfPath: string
  outputHtmlPath?: string
}

async function main(): Promise<void> {
  const options = parseArgs(process.argv.slice(2))
  const invocationCwd = getInvocationCwd()

  switch (options.command) {
    case 'render':
      await runRender(options, invocationCwd)
      return
    case 'render-dir':
      await runRenderDir(options, invocationCwd)
      return
    default:
      printUsage()
      process.exitCode = 1
  }
}

function getInvocationCwd(): string {
  return process.env.INIT_CWD || process.cwd()
}

function parseArgs(argv: string[]): CliOptions {
  if (argv[0] === '--help' || argv[0] === '-h') {
    printUsage()
    process.exit(0)
  }

  const options: CliOptions = {
    command: argv[0] ?? '',
    saveHtml: false,
    quiet: false,
  }

  for (let index = 1; index < argv.length; index += 1) {
    const arg = argv[index]

    switch (arg) {
      case '--input':
        options.input = argv[++index]
        break
      case '--output':
        options.output = argv[++index]
        break
      case '--input-dir':
        options.inputDir = argv[++index]
        break
      case '--output-dir':
        options.outputDir = argv[++index]
        break
      case '--config':
        options.config = argv[++index]
        break
      case '--save-html':
        options.saveHtml = true
        break
      case '--quiet':
        options.quiet = true
        break
      case '--help':
      case '-h':
        printUsage()
        process.exit(0)
        break
      default:
        throw new Error(`Unknown argument: ${arg}`)
    }
  }

  return options
}

function printUsage(): void {
  process.stdout.write(`Usage:
  md2pdf render --input ./notes/post.md --output ./output/post.pdf --config ./md2pdf.jsonc
  md2pdf render-dir --input-dir ./notes --output-dir ./output --config ./md2pdf.jsonc --save-html

Options:
  --input <path>                    Input Markdown file for render
  --output <path>                   Output PDF path for render
  --input-dir <path>                Input directory for render-dir
  --output-dir <path>               Output directory for render-dir
  --config <path>                   Optional JSONC config path
  --save-html                       Write intermediate HTML next to each PDF
  --quiet                           Suppress success output
`)
}

async function runRender(options: CliOptions, invocationCwd: string): Promise<void> {
  if (!options.input || !options.output) {
    throw new Error('`render` requires both --input and --output.')
  }

  const inputPath = resolve(invocationCwd, options.input)
  const outputPdfPath = resolve(invocationCwd, options.output)
  const outputHtmlPath = options.saveHtml ? replaceExtension(outputPdfPath, '.html') : undefined
  const { renderer, resolvedConfig } = await createRendererWithConfig(options, invocationCwd)

  try {
    await renderJob(
      {
        inputPath,
        outputPdfPath,
        outputHtmlPath,
      },
      renderer,
      resolvedConfig,
      options.quiet,
    )
  } finally {
    await renderer.close()
  }
}

async function runRenderDir(options: CliOptions, invocationCwd: string): Promise<void> {
  if (!options.inputDir || !options.outputDir) {
    throw new Error('`render-dir` requires both --input-dir and --output-dir.')
  }

  const inputDir = resolve(invocationCwd, options.inputDir)
  const outputDir = resolve(invocationCwd, options.outputDir)
  const markdownFiles = await collectMarkdownFiles(inputDir)
  const jobs = markdownFiles.map(inputPath => {
    const relativePath = relative(inputDir, inputPath)
    const outputPdfPath = replaceExtension(resolve(outputDir, relativePath), '.pdf')
    return {
      inputPath,
      outputPdfPath,
      outputHtmlPath: options.saveHtml ? replaceExtension(outputPdfPath, '.html') : undefined,
    } satisfies RenderJob
  })

  const { renderer, resolvedConfig } = await createRendererWithConfig(options, invocationCwd)
  let failureCount = 0

  try {
    for (const job of jobs) {
      try {
        await renderJob(job, renderer, resolvedConfig, options.quiet)
      } catch (error_) {
        failureCount += 1
        const message = error_ instanceof Error ? error_.message : String(error_)
        process.stderr.write(`Error: ${job.inputPath}: ${message}\n`)
      }
    }
  } finally {
    await renderer.close()
  }

  if (failureCount > 0) {
    throw new Error(`Failed to render ${failureCount} file(s).`)
  }
}

async function createRendererWithConfig(
  options: CliOptions,
  invocationCwd: string,
): Promise<{ renderer: PdfRenderer; resolvedConfig: ResolvedConfig }> {
  const resolvedConfig = await resolveConfig(options.config, invocationCwd)
  printDiagnostics(resolvedConfig.diagnostics)
  assertNoErrors(resolvedConfig.diagnostics)

  return {
    renderer: new PdfRenderer(),
    resolvedConfig,
  }
}

async function resolveConfig(configPathArgument: string | undefined, invocationCwd: string): Promise<ResolvedConfig> {
  const configPath = configPathArgument
    ? resolve(invocationCwd, configPathArgument)
    : resolve(invocationCwd, 'md2pdf.jsonc')

  if (!configPathArgument && !existsSync(configPath)) {
    return {
      config: {},
      stylesheets: [],
      diagnostics: [],
    }
  }

  const loaded = await loadMarkdownPdfConfig(configPath)
  const stylesheetResult = await loadConfigStylesheets(loaded.config, configPath)

  return {
    config: loaded.config,
    stylesheets: stylesheetResult.stylesheets,
    diagnostics: [...loaded.diagnostics, ...stylesheetResult.diagnostics],
  }
}

async function renderJob(
  job: RenderJob,
  renderer: PdfRenderer,
  resolvedConfig: ResolvedConfig,
  quiet: boolean,
): Promise<void> {
  const markdown = await readFile(job.inputPath, 'utf8')
  const rendered = renderMarkdownDocument({
    markdown,
    title: basename(job.inputPath, extname(job.inputPath)),
    baseDir: dirname(job.inputPath),
    config: resolvedConfig.config,
    stylesheets: resolvedConfig.stylesheets,
  })

  printDiagnostics(rendered.diagnostics)
  assertNoErrors(rendered.diagnostics)

  const pdfResult = await renderer.renderHtml({
    html: rendered.htmlArtifact.html,
    pdf: resolvedConfig.config.pdf,
    pageBreaks: resolvedConfig.config.pageBreaks,
  })

  if (job.outputHtmlPath) {
    await mkdir(dirname(job.outputHtmlPath), { recursive: true })
    await writeFile(job.outputHtmlPath, rendered.htmlArtifact.html, 'utf8')
  }

  printDiagnostics(pdfResult.diagnostics)
  assertNoErrors(pdfResult.diagnostics)

  await mkdir(dirname(job.outputPdfPath), { recursive: true })
  await writeFile(job.outputPdfPath, pdfResult.buffer)

  if (!quiet) {
    process.stdout.write(`Rendered ${job.inputPath} -> ${job.outputPdfPath}\n`)
  }
}

function printDiagnostics(diagnostics: Diagnostic[]): void {
  for (const diagnostic of diagnostics) {
    const prefix = diagnostic.level === 'error' ? 'Error' : 'Warning'
    const source = diagnostic.source ? ` [${diagnostic.source}]` : ''
    const code = diagnostic.code ? ` (${diagnostic.code})` : ''
    process.stderr.write(`${prefix}${code}${source}: ${diagnostic.message}\n`)
  }
}

function assertNoErrors(diagnostics: Diagnostic[]): void {
  const firstError = diagnostics.find(diagnostic => diagnostic.level === 'error')
  if (firstError) {
    throw new Error(firstError.message)
  }
}

async function collectMarkdownFiles(inputDir: string): Promise<string[]> {
  const entries = await readdir(inputDir, { withFileTypes: true })
  const files: string[] = []

  for (const entry of entries) {
    const absolutePath = resolve(inputDir, entry.name)
    if (entry.isDirectory()) {
      files.push(...(await collectMarkdownFiles(absolutePath)))
      continue
    }

    if (entry.isFile() && isMarkdownPath(absolutePath)) {
      files.push(absolutePath)
    }
  }

  files.sort((left, right) => left.localeCompare(right))
  return files
}

function isMarkdownPath(path: string): boolean {
  const extension = extname(path).toLocaleLowerCase()
  return extension === '.md' || extension === '.markdown'
}

function replaceExtension(path: string, nextExtension: string): string {
  return `${path.slice(0, path.length - extname(path).length)}${nextExtension}`
}

main().catch((error_: unknown) => {
  const message = error_ instanceof Error ? error_.message : String(error_)
  process.stderr.write(`Error: ${message}\n`)
  process.exit(1)
})
