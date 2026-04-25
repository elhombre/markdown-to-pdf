import MarkdownIt from 'markdown-it'
import type Token from 'markdown-it/lib/token.mjs'

import type { Diagnostic, FilteredMarkdownResult, SectionFilterConfig } from './types.js'

interface SectionRange {
  heading: string
  startLine: number
  endLine: number
}

const IGNORE_START_MARKER = '<!-- mdpdf:ignore:start -->'
const IGNORE_END_MARKER = '<!-- mdpdf:ignore:end -->'

const markdownIt = new MarkdownIt({
  html: true,
  linkify: true,
  typographer: true,
})

function error(code: string, message: string): Diagnostic {
  return { level: 'error', code, message }
}

function warning(code: string, message: string): Diagnostic {
  return { level: 'warning', code, message }
}

function normalizeHeading(value: string): string {
  return value.trim().replaceAll(/\s+/g, ' ').toLocaleLowerCase()
}

function extractInlineText(token: Token | undefined): string {
  if (!token || token.type !== 'inline') {
    return ''
  }

  return token.content.trim()
}

function collectH2Ranges(tokens: Token[], lines: string[]): SectionRange[] {
  const ranges: SectionRange[] = []

  for (let index = 0; index < tokens.length; index += 1) {
    const token = tokens[index]
    if (!token || token.type !== 'heading_open' || token.tag !== 'h2') {
      continue
    }

    const startLine = token.map?.[0]
    if (startLine === undefined) {
      continue
    }

    const inline = tokens[index + 1]
    const headingText = extractInlineText(inline)
    let endLine = lines.length

    for (let lookahead = index + 1; lookahead < tokens.length; lookahead += 1) {
      const candidate = tokens[lookahead]
      if (!candidate || candidate.type !== 'heading_open' || candidate.tag !== 'h2') {
        continue
      }

      const candidateStart = candidate.map?.[0]
      if (candidateStart !== undefined && candidateStart > startLine) {
        endLine = candidateStart
        break
      }
    }

    ranges.push({
      heading: headingText,
      startLine,
      endLine,
    })
  }

  return ranges
}

export function removeIgnoredFragments(markdown: string): FilteredMarkdownResult {
  const lines = markdown.split(/\r?\n/)
  const diagnostics: Diagnostic[] = []
  const output: string[] = []
  let ignoreStartLine: number | undefined

  for (const [index, line] of lines.entries()) {
    const trimmedLine = line.trim()

    if (trimmedLine === IGNORE_START_MARKER) {
      if (ignoreStartLine !== undefined) {
        diagnostics.push(
          error(
            'NESTED_IGNORE_FRAGMENT',
            `Nested ignore fragment markers are not supported. Found a nested start marker at line ${index + 1}.`,
          ),
        )
      } else {
        ignoreStartLine = index + 1
      }
      continue
    }

    if (trimmedLine === IGNORE_END_MARKER) {
      if (ignoreStartLine === undefined) {
        diagnostics.push(
          error(
            'UNMATCHED_IGNORE_END',
            `Found an ignore end marker at line ${index + 1} without a matching start marker.`,
          ),
        )
      } else {
        ignoreStartLine = undefined
      }
      continue
    }

    if (ignoreStartLine === undefined) {
      output.push(line)
    }
  }

  if (ignoreStartLine !== undefined) {
    diagnostics.push(
      error(
        'UNCLOSED_IGNORE_FRAGMENT',
        `Found an ignore start marker at line ${ignoreStartLine} without a matching end marker.`,
      ),
    )
  }

  return {
    markdown: output.join('\n'),
    diagnostics,
  }
}

export function filterMarkdownSections(markdown: string, sectionFilter?: SectionFilterConfig): FilteredMarkdownResult {
  if (!sectionFilter || sectionFilter.headings.length === 0) {
    return {
      markdown,
      diagnostics: [],
    }
  }

  const lines = markdown.split(/\r?\n/)
  const tokens = markdownIt.parse(markdown, {})
  const ranges = collectH2Ranges(tokens, lines)

  if (ranges.length === 0) {
    return {
      markdown,
      diagnostics: [
        warning('NO_H2_SECTIONS_FOUND', 'No level-2 sections were found, so section filtering was skipped.'),
      ],
    }
  }

  const selected = new Set(sectionFilter.headings.map(normalizeHeading))
  const slices: string[] = []
  const diagnostics: Diagnostic[] = []
  let cursor = 0
  let matchedHeadingCount = 0

  const prefaceEnd = ranges[0]?.startLine ?? lines.length
  if (prefaceEnd > 0) {
    slices.push(lines.slice(0, prefaceEnd).join('\n'))
    cursor = prefaceEnd
  }

  for (const range of ranges) {
    const normalizedHeading = normalizeHeading(range.heading)
    const isMatch = selected.has(normalizedHeading)
    if (isMatch) {
      matchedHeadingCount += 1
    }

    const shouldKeep = sectionFilter.mode === 'include' ? isMatch : !isMatch
    if (shouldKeep) {
      slices.push(lines.slice(range.startLine, range.endLine).join('\n'))
    }
    cursor = range.endLine
  }

  if (cursor < lines.length) {
    slices.push(lines.slice(cursor).join('\n'))
  }

  if (matchedHeadingCount === 0) {
    diagnostics.push(
      warning('NO_SECTION_MATCHES', 'No configured section headings matched any level-2 heading in the document.'),
    )
  }

  return {
    markdown: slices.filter(Boolean).join('\n\n').trim(),
    diagnostics,
  }
}
