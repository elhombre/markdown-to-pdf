# Markdown PDF Architecture

## Summary

This document defines the version 1 architecture for a library-first Markdown-to-PDF tool with a thin CLI wrapper.

The tool is intentionally narrow:

- take Markdown as input;
- optionally omit inline fragments marked in the source;
- optionally filter sections by heading;
- render readable HTML with a built-in default theme;
- generate PDF through a headless browser;
- expose the same core flow to both CLI and future UI surfaces.

The primary target documents for v1 are concise text-first materials such as summaries, notes, lists, memos, and short instructions.

## Goals

- Keep the user-facing model small and easy to reason about.
- Make the core reusable outside CLI from day one.
- Produce predictable, readable PDFs without requiring theme work.
- Support selective section export without editing the source Markdown.
- Support author-controlled omission of local Markdown fragments.
- Support explicit page breaks.
- Support batch generation without relaunching the browser for every file.
- Leave room for experimental layout-aware automatic page breaks between sections.

## Non-goals

- Building a full document publishing suite.
- Supporting arbitrary print-layout configuration in v1.
- Supporting WYSIWYG editing.
- Supporting complex templating, header/footer builders, or theme packs.
- Supporting every Markdown extension or arbitrary embedded HTML layouts.

## Design Principles

- The library owns the pipeline. CLI is only orchestration over files and flags.
- Markdown remains the authoring source of truth.
- Section filtering happens before HTML rendering, not after.
- The default output should look good enough without user CSS.
- Configuration must stay human-sized. If a setting is not clearly useful for the main workflow, it should not exist in v1.
- Unsupported content shapes should fail explicitly or degrade in a documented way.

## Package Layout

Standalone package layout:

- `src/core`
- `src/cli`
- `bin/md2pdf`

Responsibilities:

### `src/core`

- Load and validate config.
- Parse Markdown source.
- Remove ignored Markdown fragments.
- Filter sections.
- Detect page break markers.
- Render HTML document with bundled base CSS.
- Merge additional user stylesheets.
- Render PDF through a long-lived browser-backed renderer.
- Return structured artifacts and diagnostics.
- Optionally apply experimental layout-aware page breaks before selected section headings.

### `src/cli`

- Parse CLI arguments.
- Resolve input, output, config, and stylesheet paths.
- Support single-file and directory modes.
- Save HTML artifacts when requested.
- Print diagnostics and exit with correct status codes.

## Why `markdown-it` And `puppeteer`

Version 1 should use:

- `markdown-it` for Markdown parsing and HTML rendering;
- `puppeteer` for HTML-to-PDF rendering.

Reasons:

- `markdown-it` is already used in this monorepo and fits the current TypeScript ESM setup.
- The tool does not need a larger Markdown AST stack in v1.
- `puppeteer` provides a direct `page.pdf()` flow and is sufficient for a document-export tool.
- The same browser instance can be reused across multiple files in batch mode.

`playwright` is a valid alternative, but it does not materially improve the v1 requirements enough to justify the heavier runtime model here.

## Output Pipeline

The end-to-end flow is:

1. `loadConfig(configPath) -> MarkdownPdfConfig`
2. `readSource(markdownPath) -> string`
3. `omitIgnoredFragments(markdown) -> string`
4. `parseMarkdown(markdown) -> MarkdownDocument`
5. `filterSections(document, config.sections) -> MarkdownDocument`
6. `renderHtmlDocument(document, renderOptions) -> HtmlArtifact`
7. `renderPdf(htmlArtifact, pdfOptions) -> Uint8Array | file`

The core library should also expose a stateful renderer for reuse:

1. `createPdfRenderer(options) -> PdfRenderer`
2. `renderer.renderFile(input) -> RenderResult`
3. `renderer.renderFiles(inputs) -> RenderResult[]`
4. `renderer.close()`

This allows batch generation with a single browser lifecycle.

## Document Model

The core model should remain small and renderer-oriented.

```ts
type MarkdownDocument = {
  blocks: Block[]
}
```

```ts
type Block =
  | { type: 'heading'; level: 1 | 2 | 3 | 4 | 5 | 6; text: string; html: string }
  | { type: 'content'; markdown: string; html: string }
  | { type: 'page-break' }
```

Notes:

- v1 does not need a rich semantic AST for every inline node.
- Section filtering depends on heading boundaries, not on a full document editor model.
- A dedicated `page-break` block is enough for explicit print pagination.

## Section Filtering

Section filtering is configuration-driven and happens before final HTML rendering.

Ignored fragments are removed before section filtering is applied.

Version 1 supports filtering by level-2 headings only.

Rationale:

- this matches the expected structure of practical text summaries;
- it keeps the selection model easy to explain;
- it avoids ambiguous nesting rules in v1.

Rules:

- the preface before the first `##` heading is always preserved;
- matching headings are compared after trim, whitespace collapse, and case-insensitive normalization;
- if a heading appears more than once, the rule applies to all matching sections;
- if `sections` is omitted, the whole document is rendered;
- if `mode=include`, only matching `##` sections are kept, plus the preface;
- if `mode=exclude`, matching `##` sections are removed;
- content under nested headings belongs to the current parent `##` section;
- unmatched headings in `include` mode are simply omitted, not treated as errors.

## Ignored Fragments

Version 1 supports author-controlled omission of local Markdown fragments.

Authoring markers:

```md
<!-- mdpdf:ignore:start -->
```

```md
<!-- mdpdf:ignore:end -->
```

Rules:

- ignored fragments are removed before section filtering;
- both marker lines are removed from the result;
- nested ignored fragments are not supported in v1;
- `ignore:end` without a preceding `ignore:start` is an error;
- `ignore:start` without a matching `ignore:end` is an error;
- content inside an ignored fragment is removed exactly as written;
- headings, page break markers, and local notes inside an ignored fragment disappear with the fragment;
- ignored fragments work independently of `sections.mode=include|exclude`.

Example:

```md
## What To Do Next

1. Submit documents

<!-- mdpdf:ignore:start -->
Internal editorial note that must never reach PDF output.
<!-- mdpdf:ignore:end -->

2. Verify deadlines
```

## Page Breaks

Version 1 supports explicit author-controlled page breaks.

Authoring marker:

```md
<!-- pagebreak -->
```

Rules:

- the marker must appear on its own line;
- it is converted into an internal `page-break` block before HTML generation;
- removed sections also remove page breaks contained inside them;
- consecutive page break markers collapse into a single page break;
- leading and trailing page breaks are ignored.

HTML output should render page breaks as a dedicated element, for example:

```html
<div class="mdpdf-page-break" aria-hidden="true"></div>
```

Base CSS should force a new page with both modern and legacy print properties.

Pipeline order:

1. remove ignored fragments;
2. apply section filtering;
3. normalize page break markers;
4. render HTML;
5. render PDF.

## Configuration Format

Human-authored config should use `JSONC`. Plain JSON remains valid because it is a subset of JSONC.

Suggested file name:

- `md2pdf.jsonc`

Suggested shape:

```jsonc
{
  "sections": {
    "mode": "exclude",
    "headings": ["Ads", "Links"]
  },
  "stylesheets": ["./pdf.extra.css"],
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

Configuration model:

```ts
type MarkdownPdfConfig = {
  sections?: {
    mode: 'include' | 'exclude'
    headings: string[]
  }
  stylesheets?: string[]
  pdf?: {
    format?: 'A4' | 'Letter'
    margin?: {
      top?: string
      right?: string
      bottom?: string
      left?: string
    }
  }
}
```

Notes:

- `sections.mode` and `sections.headings` replace separate include/exclude arrays.
- `stylesheets` is a list of file paths, not raw CSS text in config.
- user stylesheets are appended after the built-in theme and can override it.
- v1 should not expose large numbers of PDF engine toggles.

## Experimental Auto Page Breaks

An experimental mode may insert page breaks before section headings based on the actual browser layout and the selected PDF page size.

Suggested config:

```jsonc
{
  "pageBreaks": {
    "mode": "auto-sections",
    "headingLevel": 2,
    "minRemainingPageHeight": "28mm",
    "keepHeadingWithNext": true,
    "avoidParagraphSplit": true,
    "maxUnbreakableParagraphHeight": "45mm",
    "keepPreambleWithList": true
  }
}
```

Config model:

```ts
type PageBreakConfig = {
  mode?: 'manual' | 'auto-sections'
  headingLevel?: 1 | 2 | 3 | 4 | 5 | 6
  minRemainingPageHeight?: string
  keepHeadingWithNext?: boolean
  avoidParagraphSplit?: boolean
  maxUnbreakableParagraphHeight?: string
  keepPreambleWithList?: boolean
}
```

Rules:

- `manual` preserves only explicit `<!-- pagebreak -->` markers;
- `auto-sections` scans headings after HTML layout in the browser and may insert a break before a section heading;
- the implementation is experimental and heuristic, not a full pagination engine;
- the default target for `auto-sections` is level-2 headings;
- `minRemainingPageHeight` defines how much printable space must remain on the current page to keep the next section in place;
- `keepHeadingWithNext=true` attempts to keep the heading together with the next block;
- `avoidParagraphSplit=true` tries to move shorter paragraphs to the next page before Chromium splits them in the middle;
- `maxUnbreakableParagraphHeight` defines the largest paragraph height that should still be treated as unbreakable;
- paragraphs taller than `maxUnbreakableParagraphHeight` may still be split to avoid large empty areas or impossible layouts;
- `keepPreambleWithList=true` tries to keep a paragraph ending with `:` together with the start of the following list or block quote;
- explicit manual page breaks remain valid and work alongside the automatic mode.

Rationale:

- this logic depends on real browser layout, page format, and margins;
- it cannot be implemented reliably from raw Markdown alone;
- the best practical place for it is the browser-backed PDF rendering stage.

## CLI Contract

The CLI should stay small and predictable.

Commands:

- `render`
- `render-dir`

Examples:

```bash
md2pdf render \
  --input ./notes/post.md \
  --output ./output/post.pdf \
  --config ./md2pdf.jsonc
```

```bash
md2pdf render-dir \
  --input-dir ./notes \
  --output-dir ./output \
  --config ./md2pdf.jsonc \
  --save-html
```

Important flags:

- `--input <path>`
- `--output <path>`
- `--input-dir <path>`
- `--output-dir <path>`
- `--config <path>`
- `--save-html`
- `--quiet`

Rules:

- `render` accepts one input file and one output PDF path;
- `render-dir` scans for Markdown files under the input directory recursively;
- `render-dir` mirrors the relative input structure inside the output directory;
- `--save-html` writes the intermediate HTML next to the generated PDF with the same basename and `.html` extension;
- in directory mode, HTML files are written for each rendered item under the mirrored output tree;
- CLI flags override config values where both exist.

Version 1 should not add separate CLI flags for section lists or raw CSS injection. Those concerns belong in the config file.

## HTML Rendering

The HTML artifact is an official intermediate output.

```ts
type HtmlArtifact = {
  html: string
  css: string
}
```

The generated HTML document should include:

- document wrapper and metadata;
- bundled base CSS;
- optional user CSS files appended after base CSS;
- semantic HTML from Markdown;
- explicit page-break elements;
- print-focused color adjustment rules.

The tool should render a complete HTML document, not an HTML fragment, because this is easier to save, inspect, and reuse in future UI tooling.

## Default Theme

The default theme should be text-first, soft, and quiet.

Design direction:

- modern sans-serif typography;
- moderate contrast without looking faded;
- clear hierarchy for headings;
- generous but not loose spacing;
- calm code blocks and blockquotes;
- no decorative print effects.

Font stack direction:

- headings: `Manrope`
- body: `Inter`
- code: `JetBrains Mono`

For deterministic output, the preferred implementation is to bundle these fonts with the tool and load them locally through `@font-face`.

Base styling requirements:

- support normal inline Markdown emphasis: bold, italic, strike, code;
- allow underlined text through inline HTML such as `<u>...</u>`;
- readable list spacing;
- clean blockquote styling;
- fenced code blocks with wrapping or horizontal overflow containment;
- table styling that stays legible in print without becoming visually heavy;
- links remain readable in grayscale-friendly output.
- level-2 section divider lines should be configurable through `sectionDividers.enabled`.

Suggested config:

```jsonc
{
  "sectionDividers": {
    "enabled": true
  }
}
```

Rules:

- this toggle applies to level-2 headings only in v1;
- `enabled: true` keeps the current visual divider above `h2` sections;
- `enabled: false` removes the divider line without changing the section hierarchy or filtering behavior;
- if omitted, the default remains enabled.

## PDF Defaults

Version 1 defaults should be conservative:

- page format: `A4`
- print background: enabled
- browser media: `screen`
- margins: readable and not edge-heavy

The renderer should use a print-safe CSS baseline:

- `-webkit-print-color-adjust: exact;`
- `print-color-adjust: exact;`

The goal is not “pixel-perfect magazine layout”. The goal is readable export with stable pagination and minimal surprises.

## Batch Rendering

Batch mode is an optimization over the same core pipeline.

Rules:

- create one browser instance per CLI process;
- create one page per render job or reuse a page safely;
- continue rendering other files after a per-file failure;
- report failed files at the end with non-zero exit code if any file failed.

The core library should not require batch mode, but it should make browser reuse natural.

## Error Handling And Diagnostics

The library should return structured diagnostics where possible.

Suggested shape:

```ts
type Diagnostic = {
  level: 'error' | 'warning'
  code: string
  message: string
  source?: string
}
```

Example diagnostics:

- missing config file;
- invalid config schema;
- unreadable stylesheet file;
- unsupported page break marker placement;
- browser launch failure;
- output write failure.

The CLI should print concise diagnostics and return non-zero status on any error.

## Future Extension Points

The v1 design should leave room for:

- a Web UI that previews the generated HTML and PDF;
- richer section selection rules;
- page headers and footers;
- alternative themes;
- additional output formats such as HTML-only export;
- cached browser service mode for long-running local workflows.

These are extension points, not part of the first implementation target.

## First Implementation Milestone

The first milestone is successful when:

- a user can render one Markdown file into a PDF;
- ignored fragment markers remove local Markdown ranges before section filtering;
- section filtering works through config with `include` and `exclude` modes;
- `<!-- pagebreak -->` creates page breaks in the final PDF;
- `--save-html` writes the intermediate HTML artifact;
- additional CSS files override the default theme;
- directory mode renders multiple Markdown files with one browser lifecycle;
- the same rendering logic is callable from TypeScript without shelling out to the CLI.
