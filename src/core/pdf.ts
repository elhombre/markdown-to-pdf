import { existsSync } from 'node:fs'
import { join } from 'node:path'

import puppeteer, { type Browser } from 'puppeteer-core'

import type { Diagnostic, PageBreakConfig, PdfConfig, RenderPdfInput, RenderPdfResult } from './types.js'

const DEFAULT_MARGIN = {
  top: '18mm',
  right: '16mm',
  bottom: '20mm',
  left: '16mm',
} as const

function error(code: string, message: string): Diagnostic {
  return { level: 'error', code, message }
}

function getExecutablePath(): string | undefined {
  const explicitPath = process.env.PUPPETEER_EXECUTABLE_PATH?.trim()
  if (explicitPath) {
    return explicitPath
  }

  const platform = process.platform
  if (platform === 'darwin') {
    return (
      [
        '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome',
        '/Applications/Brave Browser.app/Contents/MacOS/Brave Browser',
      ].find(path => existsSync(path)) ?? undefined
    )
  }

  if (platform === 'linux') {
    return (
      [
        '/usr/bin/google-chrome',
        '/usr/bin/google-chrome-stable',
        '/usr/bin/chromium',
        '/usr/bin/chromium-browser',
        '/snap/bin/chromium',
      ].find(path => existsSync(path)) ?? undefined
    )
  }

  if (platform === 'win32') {
    const candidates: string[] = []
    const localAppData = process.env.LOCALAPPDATA
    const programFiles = process.env.PROGRAMFILES
    const programFilesX86 = process.env['PROGRAMFILES(X86)']

    if (programFiles) {
      candidates.push(
        join(programFiles, 'Google', 'Chrome', 'Application', 'chrome.exe'),
        join(programFiles, 'Microsoft', 'Edge', 'Application', 'msedge.exe'),
        join(programFiles, 'BraveSoftware', 'Brave-Browser', 'Application', 'brave.exe'),
        join(programFiles, 'Chromium', 'Application', 'chrome.exe'),
      )
    }

    if (programFilesX86) {
      candidates.push(
        join(programFilesX86, 'Google', 'Chrome', 'Application', 'chrome.exe'),
        join(programFilesX86, 'Microsoft', 'Edge', 'Application', 'msedge.exe'),
        join(programFilesX86, 'BraveSoftware', 'Brave-Browser', 'Application', 'brave.exe'),
        join(programFilesX86, 'Chromium', 'Application', 'chrome.exe'),
      )
    }

    if (localAppData) {
      candidates.push(
        join(localAppData, 'Google', 'Chrome', 'Application', 'chrome.exe'),
        join(localAppData, 'Microsoft', 'Edge', 'Application', 'msedge.exe'),
        join(localAppData, 'BraveSoftware', 'Brave-Browser', 'Application', 'brave.exe'),
        join(localAppData, 'Chromium', 'Application', 'chrome.exe'),
      )
    }

    return candidates.find(path => existsSync(path))
  }

  return undefined
}

function toPdfOptions(pdf?: PdfConfig) {
  return {
    format: pdf?.format ?? 'A4',
    printBackground: true,
    margin: {
      top: pdf?.margin?.top ?? DEFAULT_MARGIN.top,
      right: pdf?.margin?.right ?? DEFAULT_MARGIN.right,
      bottom: pdf?.margin?.bottom ?? DEFAULT_MARGIN.bottom,
      left: pdf?.margin?.left ?? DEFAULT_MARGIN.left,
    },
  } as const
}

function getPageHeightForFormat(format: PdfConfig['format'] | undefined): string {
  switch (format ?? 'A4') {
    case 'Letter':
      return '279.4mm'
    case 'A4':
    default:
      return '297mm'
  }
}

async function applyAutoSectionPageBreaks(
  page: Awaited<ReturnType<Browser['newPage']>>,
  pdf: PdfConfig | undefined,
  pageBreaks: PageBreakConfig | undefined,
): Promise<void> {
  const resolvedPageBreaks = pageBreaks ?? {}
  const shouldAutoBreakSections = resolvedPageBreaks.mode === 'auto-sections'
  const shouldAvoidParagraphSplit = resolvedPageBreaks.avoidParagraphSplit ?? false
  const shouldKeepPreambleWithList = resolvedPageBreaks.keepPreambleWithList ?? false

  if (!shouldAutoBreakSections && !shouldAvoidParagraphSplit && !shouldKeepPreambleWithList) {
    return
  }

  await page.evaluate(
    ({
      autoBreakSections,
      headingLevel,
      minRemainingPageHeight,
      keepHeadingWithNext,
      avoidParagraphSplit,
      maxUnbreakableParagraphHeight,
      keepPreambleWithList,
      pageHeight,
      marginTop,
      marginBottom,
    }) => {
      function parseLength(value: string): number | null {
        const match = value.trim().match(/^(-?\d+(?:\.\d+)?)(px|mm|cm|in|pt|pc)$/i)
        if (!match) {
          return null
        }

        const numeric = Number.parseFloat(match[1] ?? '')
        const unit = (match[2] ?? 'px').toLowerCase()

        switch (unit) {
          case 'px':
            return numeric
          case 'mm':
            return (numeric * 96) / 25.4
          case 'cm':
            return (numeric * 96) / 2.54
          case 'in':
            return numeric * 96
          case 'pt':
            return (numeric * 96) / 72
          case 'pc':
            return numeric * 16
          default:
            return null
        }
      }

      function getRequirement(heading: Element, baseMinimum: number, shouldKeepHeadingWithNext: boolean): number {
        const headingRect = heading.getBoundingClientRect()
        let requirement = Math.max(baseMinimum, headingRect.height)
        if (!shouldKeepHeadingWithNext) {
          return requirement
        }

        const nextElement = heading.nextElementSibling
        if (!nextElement) {
          return requirement
        }

        const nextRect = nextElement.getBoundingClientRect()
        requirement = Math.max(requirement, headingRect.height + nextRect.height)
        return requirement
      }

      function getRemainingHeight(top: number, printableHeight: number): number {
        const offsetWithinPage = top % printableHeight
        if (offsetWithinPage < 1) {
          return printableHeight
        }

        return printableHeight - offsetWithinPage
      }

      function protectParagraphSplits(printableHeight: number, maxHeight: number): void {
        const paragraphs = [...document.querySelectorAll('.mdpdf-document p')]
        for (const paragraph of paragraphs) {
          paragraph.classList.remove('mdpdf-keep-paragraph')
          paragraph.classList.remove('mdpdf-auto-page-break')

          const rect = paragraph.getBoundingClientRect()
          if (rect.height > maxHeight) {
            continue
          }

          paragraph.classList.add('mdpdf-keep-paragraph')

          const top = rect.top + window.scrollY
          const remainingHeight = getRemainingHeight(top, printableHeight)
          if (remainingHeight < rect.height) {
            paragraph.classList.add('mdpdf-auto-page-break')
          }
        }
      }

      function getPreambleAnchorBottom(nextElement: Element): number | null {
        if (nextElement instanceof HTMLOListElement || nextElement instanceof HTMLUListElement) {
          const firstListItem = nextElement.querySelector('li')
          return firstListItem instanceof HTMLLIElement
            ? firstListItem.getBoundingClientRect().bottom + window.scrollY
            : null
        }

        if (nextElement instanceof HTMLQuoteElement) {
          const firstChild = nextElement.firstElementChild
          if (firstChild) {
            return firstChild.getBoundingClientRect().bottom + window.scrollY
          }

          return nextElement.getBoundingClientRect().bottom + window.scrollY
        }

        return null
      }

      function keepPreambleWithFollowingBlock(printablePageHeight: number): void {
        const paragraphs = [...document.querySelectorAll('.mdpdf-document p')]
        for (const paragraph of paragraphs) {
          paragraph.classList.remove('mdpdf-keep-with-next')
          paragraph.classList.remove('mdpdf-auto-page-break')

          const text = paragraph.textContent?.trim() ?? ''
          if (!text.endsWith(':')) {
            continue
          }

          const nextElement = paragraph.nextElementSibling
          if (
            !(
              nextElement instanceof HTMLOListElement ||
              nextElement instanceof HTMLUListElement ||
              nextElement instanceof HTMLQuoteElement
            )
          ) {
            continue
          }

          nextElement.classList.remove('mdpdf-keep-with-previous')

          const paragraphRect = paragraph.getBoundingClientRect()
          const anchorBottom = getPreambleAnchorBottom(nextElement)
          if (anchorBottom === null) {
            continue
          }

          const paragraphTop = paragraphRect.top + window.scrollY
          const requiredHeight = anchorBottom - paragraphTop
          const remainingHeight = getRemainingHeight(paragraphTop, printablePageHeight)

          paragraph.classList.add('mdpdf-keep-with-next')
          nextElement.classList.add('mdpdf-keep-with-previous')

          if (requiredHeight <= printablePageHeight && remainingHeight < requiredHeight) {
            paragraph.classList.add('mdpdf-auto-page-break')
          }
        }
      }

      const parsedPageHeight = parseLength(pageHeight)
      const parsedMarginTop = parseLength(marginTop)
      const parsedMarginBottom = parseLength(marginBottom)
      const parsedMinimum = parseLength(minRemainingPageHeight)
      const parsedParagraphMaximum = parseLength(maxUnbreakableParagraphHeight)

      if (
        parsedPageHeight === null ||
        parsedMarginTop === null ||
        parsedMarginBottom === null ||
        parsedMinimum === null ||
        parsedParagraphMaximum === null
      ) {
        return
      }

      const printablePageHeight = parsedPageHeight - parsedMarginTop - parsedMarginBottom
      if (printablePageHeight <= 0) {
        return
      }

      if (avoidParagraphSplit) {
        protectParagraphSplits(printablePageHeight, parsedParagraphMaximum)
      }

      if (keepPreambleWithList) {
        keepPreambleWithFollowingBlock(printablePageHeight)
      }

      if (!autoBreakSections) {
        return
      }

      const headings = [...document.querySelectorAll(`.mdpdf-document h${headingLevel}`)]
      for (const heading of headings) {
        heading.classList.remove('mdpdf-auto-page-break')
      }

      for (const heading of headings) {
        const top = heading.getBoundingClientRect().top + window.scrollY
        const offsetWithinPage = top % printablePageHeight
        if (offsetWithinPage < 1) {
          continue
        }

        const remainingHeight = printablePageHeight - offsetWithinPage
        const requiredHeight = getRequirement(heading, parsedMinimum, keepHeadingWithNext)
        if (remainingHeight < requiredHeight) {
          heading.classList.add('mdpdf-auto-page-break')
        }
      }
    },
    {
      autoBreakSections: shouldAutoBreakSections,
      headingLevel: resolvedPageBreaks.headingLevel ?? 2,
      minRemainingPageHeight: resolvedPageBreaks.minRemainingPageHeight ?? '28mm',
      keepHeadingWithNext: resolvedPageBreaks.keepHeadingWithNext ?? true,
      avoidParagraphSplit: shouldAvoidParagraphSplit,
      maxUnbreakableParagraphHeight: resolvedPageBreaks.maxUnbreakableParagraphHeight ?? '45mm',
      keepPreambleWithList: shouldKeepPreambleWithList,
      pageHeight: getPageHeightForFormat(pdf?.format),
      marginTop: pdf?.margin?.top ?? DEFAULT_MARGIN.top,
      marginBottom: pdf?.margin?.bottom ?? DEFAULT_MARGIN.bottom,
    },
  )
}

export class PdfRenderer {
  #browserPromise: Promise<Browser> | undefined

  async renderHtml(input: RenderPdfInput): Promise<RenderPdfResult> {
    const diagnostics: Diagnostic[] = []

    try {
      const browser = await this.#getBrowser()
      const page = await browser.newPage()
      try {
        await page.emulateMediaType('screen')
        await page.setContent(input.html, {
          waitUntil: 'networkidle0',
        })
        await applyAutoSectionPageBreaks(page, input.pdf, input.pageBreaks)
        const buffer = await page.pdf(toPdfOptions(input.pdf))
        return {
          buffer,
          diagnostics,
        }
      } finally {
        await page.close()
      }
    } catch (error_) {
      this.#browserPromise = undefined
      const message = error_ instanceof Error ? error_.message : String(error_)
      diagnostics.push(error('PDF_RENDER_FAILED', `Failed to render PDF: ${message}`))
      return {
        buffer: new Uint8Array(),
        diagnostics,
      }
    }
  }

  async close(): Promise<void> {
    if (!this.#browserPromise) {
      return
    }

    const browser = await this.#browserPromise.catch(() => undefined)
    await browser?.close()
    this.#browserPromise = undefined
  }

  async #getBrowser(): Promise<Browser> {
    if (!this.#browserPromise) {
      const executablePath = getExecutablePath()
      this.#browserPromise = puppeteer.launch({
        executablePath,
        headless: true,
      })
    }

    return this.#browserPromise
  }
}
