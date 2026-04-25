# markdown-to-pdf

Opinionated Markdown-to-PDF tooling for quick, polished PDFs from simple text documents.

This is not a universal publishing system. It is designed for practical, text-first documents such as memos, checklists, short instructions, briefs, distilled post collections, and similar formats where a good default theme is more useful than a large layout framework.

The package includes:

- a reusable TypeScript library;
- a `md2pdf` CLI;
- a built-in readable PDF theme;
- JSONC configuration;
- section filtering;
- ignored Markdown fragments;
- manual and experimental automatic page breaks;
- Puppeteer-backed PDF rendering.

## Requirements

- Node.js 20 or newer.
- A browser runtime usable by Puppeteer.

The package depends on `puppeteer`, so normal npm installs can use Puppeteer's managed browser. If that browser is unavailable, the renderer tries `PUPPETEER_EXECUTABLE_PATH` and common Chrome, Chromium, Edge, and Brave locations on macOS, Linux, and Windows.

## Install

```bash
npm install markdown-to-pdf
```

For global CLI usage:

```bash
npm install -g markdown-to-pdf
md2pdf --help
```

GitHub source installs depend on lifecycle hooks because generated `dist` files are not committed. With Yarn, use the Git protocol form instead of the `github:` shorthand so the package is packed and built before installation:

```json
{
  "dependencies": {
    "markdown-to-pdf": "git+https://github.com/elhombre/markdown-to-pdf.git"
  }
}
```

The package includes `prepare` and `prepack` scripts, both running `npm run build`.

## CLI

Render one Markdown file:

```bash
md2pdf render --input ./notes/memo.md --output ./output/memo.pdf
```

Render with config and save the intermediate HTML:

```bash
md2pdf render \
  --input ./notes/memo.md \
  --output ./output/memo.pdf \
  --config ./md2pdf.jsonc \
  --save-html
```

Render a directory tree:

```bash
md2pdf render-dir \
  --input-dir ./notes \
  --output-dir ./output \
  --config ./md2pdf.jsonc \
  --save-html
```

Options:

- `--input <path>`: Markdown file for `render`.
- `--output <path>`: PDF path for `render`.
- `--input-dir <path>`: Markdown source directory for `render-dir`.
- `--output-dir <path>`: PDF output directory for `render-dir`.
- `--config <path>`: JSONC config path.
- `--save-html`: write the intermediate HTML next to each PDF.
- `--quiet`: suppress success output.

If `--config` is omitted, the CLI only checks `md2pdf.jsonc` in the invocation directory. No fallback config names are tried.

## Configuration

Example config: [examples/md2pdf.jsonc](./examples/md2pdf.jsonc).

```jsonc
{
  "sections": {
    "mode": "include",
    "headings": ["Summary", "Checklist", "Important"]
  },
  "stylesheets": ["./pdf.extra.css"],
  "sectionDividers": {
    "enabled": true
  },
  "pageBreaks": {
    "mode": "auto-sections",
    "headingLevel": 2,
    "minRemainingPageHeight": "28mm",
    "keepHeadingWithNext": true,
    "avoidParagraphSplit": true,
    "maxUnbreakableParagraphHeight": "45mm",
    "keepPreambleWithList": true
  },
  "pdf": {
    "format": "A4",
    "margin": {
      "top": "18mm",
      "right": "16mm",
      "bottom": "20mm",
      "left": "16mm"
    }
  }
}
```

Config notes:

- `sections.mode` can be `include` or `exclude`.
- `sections.headings` matches level-2 headings only.
- `stylesheets` paths are resolved relative to the config file.
- `sectionDividers.enabled` toggles the default divider above level-2 headings.
- `pageBreaks.mode = "auto-sections"` enables experimental layout-aware page breaks.
- `pdf.format` supports `A4` and `Letter`.
- `pdf.margin` values are passed through to Puppeteer as CSS length strings.

## Markdown Features

Ignore local source fragments without deleting them from Markdown:

```md
<!-- mdpdf:ignore:start -->
Internal note omitted from the PDF.
<!-- mdpdf:ignore:end -->
```

Rules:

- ignored fragments are removed before section filtering;
- nested ignore fragments are rejected;
- unmatched start or end markers are reported as errors.

Add an explicit page break:

```md
<!-- pagebreak -->
```

Rules:

- the marker must be on its own line;
- leading and trailing page breaks are ignored with warnings;
- consecutive page breaks are collapsed.

Local images are embedded as data URLs when possible. Local links are resolved to file URLs relative to the Markdown file.

## Library API

Main import:

```ts
import {
  renderMarkdownToPdf,
  renderMarkdownFileToPdf,
  loadMarkdownPdfConfigWithStylesheets,
  PdfRenderer,
} from 'markdown-to-pdf'
```

Core-only import:

```ts
import {
  renderMarkdownDocument,
  renderMarkdownToHtml,
  loadMarkdownPdfConfig,
  loadConfigStylesheets,
  filterMarkdownSections,
  removeIgnoredFragments,
} from 'markdown-to-pdf/core'
```

Render Markdown text to PDF bytes:

```ts
import { renderMarkdownToPdf } from 'markdown-to-pdf'

const result = await renderMarkdownToPdf({
  markdown,
  title: 'Checklist',
  baseDir: process.cwd(),
  config: {
    pdf: {
      format: 'A4',
      margin: { top: '18mm', right: '16mm', bottom: '20mm', left: '16mm' },
    },
  },
})

if (result.diagnostics.some(diagnostic => diagnostic.level === 'error')) {
  throw new Error('Markdown could not be rendered')
}

await writeFile('./checklist.pdf', result.pdf)
```

Render a file and write the PDF:

```ts
import { renderMarkdownFileToPdf } from 'markdown-to-pdf'

const result = await renderMarkdownFileToPdf({
  inputPath: './examples/memo.md',
  outputPath: './output/memo.pdf',
  configPath: './examples/md2pdf.jsonc',
  saveHtmlPath: './output/memo.html',
})
```

Reuse one browser for batches:

```ts
import { PdfRenderer, renderMarkdownFileToPdf } from 'markdown-to-pdf'

const renderer = new PdfRenderer()

try {
  for (const inputPath of markdownFiles) {
    await renderMarkdownFileToPdf({
      inputPath,
      outputPath: inputPath.replace(/\.md$/, '.pdf'),
      renderer,
    })
  }
} finally {
  await renderer.close()
}
```

Diagnostics are returned as structured objects:

```ts
type Diagnostic = {
  level: 'error' | 'warning'
  code: string
  message: string
  source?: string
}
```

## Architecture

See [docs/architecture.md](./docs/architecture.md) for the original library-first design notes.
