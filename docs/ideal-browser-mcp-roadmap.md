# Ideal Browser MCP Roadmap

## Product goal

Build a browser MCP that feels close to a careful human operator:

- works in the user's real logged-in browser profile
- does not steal the user's cursor
- defaults to safe background work on duplicated tabs
- understands page structure, accessibility semantics, and visual state
- can perform reliable actions on modern web apps
- gives the agent enough context to explain what is happening and why

## Design principles

1. User-first isolation
   The default operating mode should avoid mutating the user's original tab unless explicitly requested.

2. Background-safe execution
   The user should be able to keep browsing while the agent works on a worker tab.

3. Human-grade perception
   DOM, AX tree, visual capture, and page events should be fused into one coherent state model.

4. Native-feeling actions
   Prefer browser-native input primitives over brittle DOM shortcuts when precision matters.

5. Deterministic workflows
   Every significant action should have preconditions, postconditions, and retry/wait rules.

6. Honest confidence
   The MCP should distinguish between structural certainty, inferred intent, and visual uncertainty.

## Target architecture

### Layer 1: Session isolation

- task sessions with `sessionId`
- duplicate-tab worker strategy by default
- worker tab lifecycle management
- stale session detection

### Layer 2: Browser control

- tab and window management
- background-safe duplication
- tab close / cleanup
- navigation and history primitives

### Layer 3: Perception

- DOM structural snapshot
- accessibility tree via CDP
- DOMSnapshot capture for flattened layout and style data
- screenshot capture that does not require bringing the tab to front
- optional OCR and vision model pass for images, canvas, and charts

### Layer 4: Action engine

- semantic click and type
- native pointer and keyboard events through CDP Input domain
- drag, hover, wheel, and gesture primitives
- safer waits around navigation, network idle, and element state

### Layer 5: Reasoning surface for the agent

- action candidates ranked by intent
- form models and validation state
- dialog / modal detection
- confidence scores and uncertainty notes
- structured explanations of what changed after each action

## Phased implementation plan

### Phase 1: Safe task sessions

Goal:
Make isolation the default so the agent can work in a duplicated tab without disrupting the user.

Scope:

- add `duplicate_tab`
- add `start_task_session`, `list_task_sessions`, `close_task_session`
- route all existing actions through `sessionId`
- preserve user focus during duplication

Success criteria:

- a user can keep using the original tab while the agent operates on the worker tab
- the MCP has a durable session abstraction for later phases

### Phase 2: CDP control backbone

Goal:
Replace focus-sensitive and DOM-shortcut actions with a true browser instrumentation layer.

Scope:

- add `debugger` permission
- attach via `chrome.debugger`
- build a tab-scoped CDP session manager
- use `Page.captureScreenshot` instead of focus-stealing capture
- use `Input.dispatchMouseEvent`, `Input.dispatchKeyEvent`, `Input.insertText`

Success criteria:

- screenshots no longer require activating the worker tab
- pointer and keyboard actions behave closer to real user input

### Phase 3: Deep page understanding

Goal:
Move from "DOM snapshot" to a fused world model of the page.

Scope:

- `Accessibility.getFullAXTree`
- `DOMSnapshot.captureSnapshot`
- better iframe and shadow DOM coverage
- map DOM nodes, AX nodes, and layout boxes into unified element identities
- add richer state for forms, menus, popovers, editors, tables, and virtualized lists

Success criteria:

- the agent can explain page state more accurately
- action targeting becomes more reliable on complex apps

### Phase 4: Visual intelligence

Goal:
Handle image-heavy and canvas-heavy applications far better.

Scope:

- vision pass on screenshots
- OCR for text in images
- image-region grounding against DOM boxes
- support for charts, canvas UIs, and mixed visual/DOM interfaces

Success criteria:

- the agent can reason about content not fully represented in the DOM
- TradingView-like pages become significantly more workable

### Phase 5: Robust workflow engine

Goal:
Make the MCP resilient under real-world browsing conditions.

Scope:

- smart waits for navigation, DOM mutations, and network settling
- action replay protection
- retry policies by failure type
- login wall and cookie banner strategies
- audit logs and step traces

Success criteria:

- long multi-step tasks become dependable
- the agent can recover from transient site behavior

### Phase 6: Human-grade interaction set

Goal:
Support richer interaction patterns that advanced sites expect.

Scope:

- hover
- drag and drop
- precise wheel and inertial scrolling
- text selection
- clipboard workflows
- file uploads
- tab groups / worker grouping

Success criteria:

- the MCP can handle more product and QA workflows without manual fallback

## Recommended execution order

1. Phase 1 now
2. Phase 2 next
3. Phase 3 immediately after
4. Phase 4 for image-heavy products
5. Phase 5 and 6 as hardening
