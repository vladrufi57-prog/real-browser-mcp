# Phase 5 Slice: Minimal Smart Waits

## Goal

Add a narrow but reliable wait layer so the MCP can handle the most common post-action races without guessing blindly.

## Scope

- add minimal wait tools for:
  - navigation/document readiness
  - URL changes
  - element existence/visibility checks from the current DOM
  - CDP-backed network idle checks
- keep waits usable with either `tabId` or `sessionId`
- add optional post-action waits to `click_element` and `type_into_element`
- avoid over-designing a full workflow engine in this pass

## Touched Files

- `extension/background.js`
- `src/server/index.ts`
- `src/server/types.ts`
- `README.md`

## Constraints

- preserve the existing MCP tool surface
- prefer explicit timeout arguments over hidden long waits
- return enough diagnostic detail for the caller to understand why a wait passed or timed out

## Validation

- `node --check extension/background.js`
- `npm run check`
- `npm run build`

## Completion Criteria

- the MCP exposes minimal wait tools that work with current tabs and task sessions
- waits report success and timeout states clearly
- click/type can optionally run post-action waits
- docs mention the new reliability primitives
