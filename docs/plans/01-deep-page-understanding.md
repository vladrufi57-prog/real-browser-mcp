# Phase 3: Deep Page Understanding

## Goal

Move `snapshot_tab` from a DOM-only structural snapshot to a fused page model that includes CDP accessibility and layout insight, plus better coverage of same-origin iframes and open shadow DOM.

## Scope

- extend the page snapshot model with:
  - CDP accessibility summary
  - DOMSnapshot-derived layout summary
  - richer UI-state flags for menus, popovers, editors, tables, virtualized lists, iframe presence, and shadow DOM presence
  - frame/context metadata for the top document and nested same-origin contexts
- improve DOM extraction to walk:
  - the main document
  - open shadow roots
  - same-origin iframe documents
- enrich tracked elements with enough metadata to correlate DOM, AX, and layout perspectives where possible
- keep the response size bounded and useful for agent reasoning

## Touched Files

- `extension/background.js`
- `src/server/types.ts`
- `README.md`

## Constraints

- do not regress existing tools or session routing
- keep the MCP payload JSON-serializable and reasonably compact
- if full DOMSnapshot/AX raw payloads are too large, return summarized structures instead of dumping protocol responses

## Validation

- `node --check extension/background.js`
- `npm run check`
- `npm run build`

## Completion Criteria

- `snapshot_tab` returns richer state flags and the new perception sections
- same-origin iframe/open shadow DOM content is represented in the structural snapshot
- CDP accessibility/layout capture works on normal web pages without breaking screenshot/input flows
- docs reflect the stronger perception model
