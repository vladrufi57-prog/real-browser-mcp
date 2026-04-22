# Real Browser MCP

`real-browser-mcp` is a from-scratch browser automation stack for coding agents that need to control an already-open browser profile instead of launching a separate automation browser.

## What it solves

- Uses the browser profile you already browse with, so logged-in sessions are preserved.
- Auto-discovers open tabs instead of requiring a manual per-tab "Connect" click.
- Exposes the browser through MCP tools that feel like browser actions, not low-level protocol noise.
- Gives the agent a structural understanding of the page through DOM snapshots and screenshots.

## Architecture

- `src/server`
  - stdio MCP server for Codex-compatible clients
  - local WebSocket relay on `127.0.0.1:17373`
  - screenshot artifact storage in `.artifacts/screenshots`
- `extension`
  - Chromium MV3 extension
  - auto-connects to the local relay on startup
  - watches all tabs and mirrors tab state back to the relay
  - executes clicks, typing, scrolling, navigation, snapshots, and screenshots inside the real browser

## Current toolset

- `bridge_status`
- `cdp_status`
- `list_tabs`
- `list_task_sessions`
- `start_task_session`
- `close_task_session`
- `focus_tab`
- `duplicate_tab`
- `open_tab`
- `navigate_tab`
- `snapshot_tab`
- `click_element`
- `type_into_element`
- `select_option`
- `press_key`
- `scroll_page`
- `capture_screenshot`
- `evaluate_script`

## Page understanding

This stack is intentionally hybrid:

- Strong at structure:
  - URLs, titles, ready state, active field, visible text, headings, forms, buttons, links, labels, landmarks, images, and bounding boxes
  - primary action candidates so the agent can quickly understand what matters on the current screen
  - interacting with elements by stable element ids from a page snapshot
- Strong at browser actions:
  - opening tabs, focusing tabs, navigating, clicking, typing, selecting options, pressing keys, scrolling, taking screenshots
- Medium at visual interpretation:
  - screenshots are captured and stored locally
  - image metadata, captions, `alt` text, and surrounding DOM context are extracted
  - the current implementation does not yet include a full vision-model pipeline for arbitrary semantic image understanding
- Not magic:
  - charts, memes, game canvases, CAPTCHAs, and subtle purely visual states still need a dedicated vision layer

In plain language: for normal websites and UI flows this should be much smarter than a dumb click bot, because it reasons over the DOM and visible text. For "understand this picture exactly like a human" we still need a second-stage vision integration.

## Background-safe workflow

The bridge now supports isolated task sessions:

- duplicate the current tab into a worker copy
- preserve the user's current focus while the duplicate is created
- operate on the worker copy by `sessionId` instead of touching the original tab

This is the foundation for non-invasive browsing workflows where the user keeps using the browser while the agent works in parallel.

## CDP foundation

The extension now includes a Chrome DevTools Protocol backbone through `chrome.debugger`:

- debugger sessions are attached lazily only when needed
- attachments auto-detach after a short idle window
- screenshots use `Page.captureScreenshot` instead of activating the tab first
- internal browser pages fall back to `tabs.captureVisibleTab`, then restore the user's previous focus

Important tradeoff:

- the `debugger` permission causes Chrome to show a debugging banner while a tab is attached
- this is the technical price for stronger background-safe control and future human-like input

## Install

### 1. Build the server

```powershell
cd D:\Desktop\real-browser-mcp
"C:\Program Files\nodejs\npm.cmd" install
"C:\Program Files\nodejs\npm.cmd" run build
```

### 2. Load the extension

1. Open `chrome://extensions`
2. Enable `Developer mode`
3. Click `Load unpacked`
4. Select `D:\Desktop\real-browser-mcp\extension`

The extension auto-connects to the local relay and auto-syncs open tabs. There is no per-tab connect button in this product.

### 3. Add the MCP server to Codex

Use the built file:

`D:\Desktop\real-browser-mcp\dist\server\index.js`

An example entry is already added to `D:\.codex\config.toml`.

## Notes

- First target is Chrome/Chromium-family browsers.
- The bridge is local-only and listens on `127.0.0.1`.
- If you change server code, rerun `npm run build`.
