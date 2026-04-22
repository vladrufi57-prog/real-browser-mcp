# Architecture Notes

## Why not a spawned automation browser

Traditional MCP browser servers often launch a separate Playwright or Puppeteer browser profile. That breaks the exact thing this project is for:

- existing logins
- existing cookies
- existing extension state
- your real browser fingerprint

This project instead treats the already-open browser as the source of truth.

## Why the extension exists

Two requirements conflict a little:

- no manual per-tab connect
- full control over the tabs you already have open

The cleanest way to do both on Windows and Chromium is a local bridge extension:

- it can discover and track every open tab
- it can execute scripts in those tabs
- it can capture screenshots from the actual browsing session
- it avoids launching another browser instance

## Understanding model

The page-understanding pipeline is intentionally layered:

1. DOM snapshot
2. UI state extraction
3. Semantic extraction for forms, landmarks, headings, images, and likely actions
4. Actionable element ids
5. Screenshot capture
6. Optional future OCR / vision

This means the agent does not have to guess blindly from pixels for normal websites.

## Future upgrades

- accessibility tree via CDP
- OCR for text baked into images
- visual-diff and template matching
- network/console capture
- smarter waits and workflow primitives
