import { readFile } from 'node:fs/promises'
import { dirname, resolve } from 'node:path'
import { parse, printParseErrorCode } from 'jsonc-parser'

import type {
  Diagnostic,
  LoadedStylesheet,
  MarkdownPdfConfig,
  PageBreakConfig,
  PdfConfig,
  SectionDividerConfig,
  SectionFilterConfig,
} from './types.js'

function error(code: string, message: string, source?: string): Diagnostic {
  return { level: 'error', code, message, source }
}

function warning(code: string, message: string, source?: string): Diagnostic {
  return { level: 'warning', code, message, source }
}

function isStringArray(value: unknown): value is string[] {
  return Array.isArray(value) && value.every(item => typeof item === 'string')
}

function validateSectionFilterConfig(value: unknown, diagnostics: Diagnostic[]): SectionFilterConfig | undefined {
  if (value === undefined) {
    return undefined
  }

  if (!value || typeof value !== 'object') {
    diagnostics.push(error('INVALID_SECTIONS_CONFIG', '`sections` must be an object.'))
    return undefined
  }

  const candidate = value as Record<string, unknown>
  const mode = candidate.mode
  const headings = candidate.headings

  if (mode !== 'include' && mode !== 'exclude') {
    diagnostics.push(error('INVALID_SECTIONS_MODE', '`sections.mode` must be `include` or `exclude`.'))
    return undefined
  }

  if (!isStringArray(headings)) {
    diagnostics.push(error('INVALID_SECTION_HEADINGS', '`sections.headings` must be an array of strings.'))
    return undefined
  }

  const normalizedHeadings = headings.map(heading => heading.trim()).filter(Boolean)
  if (normalizedHeadings.length === 0) {
    diagnostics.push(
      warning('EMPTY_SECTION_HEADINGS', '`sections.headings` is empty, so no filtering will be applied.'),
    )
    return undefined
  }

  return {
    mode,
    headings: normalizedHeadings,
  }
}

function validatePdfConfig(value: unknown, diagnostics: Diagnostic[]): PdfConfig | undefined {
  if (value === undefined) {
    return undefined
  }

  if (!value || typeof value !== 'object') {
    diagnostics.push(error('INVALID_PDF_CONFIG', '`pdf` must be an object.'))
    return undefined
  }

  const candidate = value as Record<string, unknown>
  const format = candidate.format
  const margin = candidate.margin

  const pdfConfig: PdfConfig = {}

  if (format !== undefined) {
    if (format === 'A4' || format === 'Letter') {
      pdfConfig.format = format
    } else {
      diagnostics.push(error('INVALID_PDF_FORMAT', '`pdf.format` must be `A4` or `Letter`.'))
    }
  }

  if (margin !== undefined) {
    if (!margin || typeof margin !== 'object') {
      diagnostics.push(error('INVALID_PDF_MARGIN', '`pdf.margin` must be an object.'))
    } else {
      const marginCandidate = margin as Record<string, unknown>
      const marginConfig: PdfConfig['margin'] = {}
      for (const side of ['top', 'right', 'bottom', 'left'] as const) {
        const rawValue = marginCandidate[side]
        if (rawValue === undefined) {
          continue
        }

        if (typeof rawValue !== 'string' || rawValue.trim().length === 0) {
          diagnostics.push(error('INVALID_PDF_MARGIN_VALUE', `\`pdf.margin.${side}\` must be a non-empty string.`))
          continue
        }

        marginConfig[side] = rawValue.trim()
      }
      pdfConfig.margin = marginConfig
    }
  }

  return pdfConfig
}

function validatePageBreakConfig(value: unknown, diagnostics: Diagnostic[]): PageBreakConfig | undefined {
  if (value === undefined) {
    return undefined
  }

  if (!value || typeof value !== 'object') {
    diagnostics.push(error('INVALID_PAGE_BREAKS_CONFIG', '`pageBreaks` must be an object.'))
    return undefined
  }

  const candidate = value as Record<string, unknown>
  const config: PageBreakConfig = {}

  if (candidate.mode !== undefined) {
    if (candidate.mode === 'manual' || candidate.mode === 'auto-sections') {
      config.mode = candidate.mode
    } else {
      diagnostics.push(error('INVALID_PAGE_BREAKS_MODE', '`pageBreaks.mode` must be `manual` or `auto-sections`.'))
    }
  }

  if (candidate.headingLevel !== undefined) {
    const level = candidate.headingLevel
    if (typeof level === 'number' && Number.isInteger(level) && level >= 1 && level <= 6) {
      config.headingLevel = level as PageBreakConfig['headingLevel']
    } else {
      diagnostics.push(
        error('INVALID_PAGE_BREAKS_HEADING_LEVEL', '`pageBreaks.headingLevel` must be an integer from 1 to 6.'),
      )
    }
  }

  if (candidate.minRemainingPageHeight !== undefined) {
    if (typeof candidate.minRemainingPageHeight === 'string' && candidate.minRemainingPageHeight.trim().length > 0) {
      config.minRemainingPageHeight = candidate.minRemainingPageHeight.trim()
    } else {
      diagnostics.push(
        error('INVALID_PAGE_BREAKS_MIN_HEIGHT', '`pageBreaks.minRemainingPageHeight` must be a non-empty string.'),
      )
    }
  }

  if (candidate.keepHeadingWithNext !== undefined) {
    if (typeof candidate.keepHeadingWithNext === 'boolean') {
      config.keepHeadingWithNext = candidate.keepHeadingWithNext
    } else {
      diagnostics.push(error('INVALID_PAGE_BREAKS_KEEP_HEADING', '`pageBreaks.keepHeadingWithNext` must be a boolean.'))
    }
  }

  if (candidate.avoidParagraphSplit !== undefined) {
    if (typeof candidate.avoidParagraphSplit === 'boolean') {
      config.avoidParagraphSplit = candidate.avoidParagraphSplit
    } else {
      diagnostics.push(
        error('INVALID_PAGE_BREAKS_AVOID_PARAGRAPH_SPLIT', '`pageBreaks.avoidParagraphSplit` must be a boolean.'),
      )
    }
  }

  if (candidate.maxUnbreakableParagraphHeight !== undefined) {
    if (
      typeof candidate.maxUnbreakableParagraphHeight === 'string' &&
      candidate.maxUnbreakableParagraphHeight.trim().length > 0
    ) {
      config.maxUnbreakableParagraphHeight = candidate.maxUnbreakableParagraphHeight.trim()
    } else {
      diagnostics.push(
        error(
          'INVALID_PAGE_BREAKS_MAX_UNBREAKABLE_PARAGRAPH_HEIGHT',
          '`pageBreaks.maxUnbreakableParagraphHeight` must be a non-empty string.',
        ),
      )
    }
  }

  if (candidate.keepPreambleWithList !== undefined) {
    if (typeof candidate.keepPreambleWithList === 'boolean') {
      config.keepPreambleWithList = candidate.keepPreambleWithList
    } else {
      diagnostics.push(
        error('INVALID_PAGE_BREAKS_KEEP_PREAMBLE', '`pageBreaks.keepPreambleWithList` must be a boolean.'),
      )
    }
  }

  return config
}

function validateSectionDividerConfig(value: unknown, diagnostics: Diagnostic[]): SectionDividerConfig | undefined {
  if (value === undefined) {
    return undefined
  }

  if (!value || typeof value !== 'object') {
    diagnostics.push(error('INVALID_SECTION_DIVIDERS_CONFIG', '`sectionDividers` must be an object.'))
    return undefined
  }

  const candidate = value as Record<string, unknown>
  const config: SectionDividerConfig = {}

  if (candidate.enabled !== undefined) {
    if (typeof candidate.enabled === 'boolean') {
      config.enabled = candidate.enabled
    } else {
      diagnostics.push(error('INVALID_SECTION_DIVIDERS_ENABLED', '`sectionDividers.enabled` must be a boolean.'))
    }
  }

  return config
}

export function parseMarkdownPdfConfig(text: string): { config: MarkdownPdfConfig; diagnostics: Diagnostic[] } {
  const diagnostics: Diagnostic[] = []
  const parseErrors: Parameters<typeof parse>[1] = []
  const parsed = parse(text, parseErrors)

  for (const parseError of parseErrors) {
    diagnostics.push(
      error(
        'CONFIG_PARSE_ERROR',
        `Failed to parse config: ${printParseErrorCode(parseError.error)} at offset ${parseError.offset}.`,
      ),
    )
  }

  if (parseErrors.length > 0) {
    return { config: {}, diagnostics }
  }

  if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) {
    diagnostics.push(error('INVALID_CONFIG_ROOT', 'Config root must be an object.'))
    return { config: {}, diagnostics }
  }

  const candidate = parsed as Record<string, unknown>
  const config: MarkdownPdfConfig = {}

  if (candidate.stylesheets !== undefined) {
    if (!isStringArray(candidate.stylesheets)) {
      diagnostics.push(error('INVALID_STYLESHEETS', '`stylesheets` must be an array of strings.'))
    } else {
      config.stylesheets = candidate.stylesheets.map(path => path.trim()).filter(Boolean)
    }
  }

  const sections = validateSectionFilterConfig(candidate.sections, diagnostics)
  if (sections) {
    config.sections = sections
  }

  const pdf = validatePdfConfig(candidate.pdf, diagnostics)
  if (pdf) {
    config.pdf = pdf
  }

  const pageBreaks = validatePageBreakConfig(candidate.pageBreaks, diagnostics)
  if (pageBreaks) {
    config.pageBreaks = pageBreaks
  }

  const sectionDividers = validateSectionDividerConfig(candidate.sectionDividers, diagnostics)
  if (sectionDividers) {
    config.sectionDividers = sectionDividers
  }

  return { config, diagnostics }
}

export async function loadMarkdownPdfConfig(
  configPath: string,
): Promise<{ config: MarkdownPdfConfig; diagnostics: Diagnostic[] }> {
  const text = await readFile(configPath, 'utf8')
  const { config, diagnostics } = parseMarkdownPdfConfig(text)
  return {
    config,
    diagnostics: diagnostics.map(diagnostic =>
      diagnostic.source ? diagnostic : { ...diagnostic, source: configPath },
    ),
  }
}

export async function loadConfigStylesheets(
  config: MarkdownPdfConfig,
  configPath: string,
): Promise<{ stylesheets: LoadedStylesheet[]; diagnostics: Diagnostic[] }> {
  const diagnostics: Diagnostic[] = []
  const configDir = dirname(configPath)
  const stylesheets: LoadedStylesheet[] = []

  for (const stylesheetPath of config.stylesheets ?? []) {
    const absolutePath = resolve(configDir, stylesheetPath)
    try {
      const css = await readFile(absolutePath, 'utf8')
      stylesheets.push({
        path: absolutePath,
        css,
      })
    } catch (error_) {
      const message = error_ instanceof Error ? error_.message : String(error_)
      diagnostics.push(
        error('STYLESHEET_READ_FAILED', `Failed to read stylesheet "${stylesheetPath}": ${message}`, absolutePath),
      )
    }
  }

  return { stylesheets, diagnostics }
}
