import { writeFile } from "node:fs/promises";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { z } from "zod";
import { LocalBrowserRelay } from "./relay.js";
import { ensureArtifactsDir, errorResult, jsonText, nextScreenshotPath, textResult } from "./results.js";
import { TaskSessionRegistry } from "./task-sessions.js";
import type { BrowserTab, PageSnapshot } from "./types.js";

type PageStateResult = {
  url: string;
  title: string;
  readyState: string;
  documentToken: string;
};

type ElementStateResult = {
  exists: boolean;
  elementId: string;
  tagName?: string;
  role?: string;
  visible?: boolean;
  disabled?: boolean;
  editable?: boolean;
  text?: string;
  value?: string;
};

const RELAY_PORT = Number(process.env.REAL_BROWSER_MCP_PORT ?? 17373);
const relay = new LocalBrowserRelay(RELAY_PORT);
const sessions = new TaskSessionRegistry(() => relay.listTabs());

const server = new McpServer(
  {
    name: "real-browser-mcp",
    version: "0.1.0",
  },
  {
    capabilities: {
      logging: {},
    },
  },
);

function pickTab(tabId: number | undefined): BrowserTab {
  const tabs = relay.listTabs();
  if (tabs.length === 0) {
    throw new Error(
      "No browser tabs are connected. Make sure the browser extension is installed and connected to the relay.",
    );
  }

  if (tabId !== undefined) {
    const tab = tabs.find((entry) => entry.tabId === tabId);
    if (!tab) {
      throw new Error(`Tab ${tabId} was not found.`);
    }
    return tab;
  }

  return tabs.find((entry) => entry.active) ?? tabs[0];
}

function pickTargetTab(input: {
  tabId?: number;
  sessionId?: string;
}): BrowserTab {
  if (input.tabId !== undefined && input.sessionId !== undefined) {
    throw new Error("Provide either 'tabId' or 'sessionId', not both.");
  }

  if (input.sessionId) {
    const session = sessions.touch(input.sessionId);
    if (!session.workerTab) {
      throw new Error(
        `Task session '${input.sessionId}' has no live worker tab. Create a new session or close the stale one.`,
      );
    }
    return session.workerTab;
  }

  return pickTab(input.tabId);
}

async function resolveElementTarget(input: {
  elementId: string;
  tabId?: number;
  sessionId?: string;
}): Promise<{
  tab: BrowserTab;
  target: {
    elementId: string;
    tagName: string;
    text?: string;
    label?: string;
    bbox: { x: number; y: number; width: number; height: number };
    center: { x: number; y: number };
  };
}> {
  const tab = pickTargetTab({ tabId: input.tabId, sessionId: input.sessionId });
  const target = (await relay.call("getElementTarget", {
    tabId: tab.tabId,
    elementId: input.elementId,
  })) as {
    elementId: string;
    tagName: string;
    text?: string;
    label?: string;
    bbox: { x: number; y: number; width: number; height: number };
    center: { x: number; y: number };
  };

  return {
    tab,
    target,
  };
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => {
    setTimeout(resolve, ms);
  });
}

async function getPageState(tabId: number): Promise<PageStateResult> {
  return (await relay.call("getPageState", {
    tabId,
  })) as PageStateResult;
}

async function getElementState(tabId: number, elementId: string): Promise<ElementStateResult> {
  return (await relay.call("getElementState", {
    tabId,
    elementId,
  })) as ElementStateResult;
}

async function waitForNetworkIdle(input: {
  tabId: number;
  idleMs?: number;
  timeoutMs?: number;
  maxInflightRequests?: number;
}): Promise<{
  idle: boolean;
  timedOut: boolean;
  inflightRequests: number;
  idleForMs: number;
  elapsedMs: number;
  lastNetworkActivityAt?: string;
}> {
  return (await relay.call("waitForNetworkIdle", {
    tabId: input.tabId,
    idleMs: input.idleMs ?? 1000,
    timeoutMs: input.timeoutMs ?? 15000,
    maxInflightRequests: input.maxInflightRequests ?? 0,
  }, (input.timeoutMs ?? 15000) + 1000)) as {
    idle: boolean;
    timedOut: boolean;
    inflightRequests: number;
    idleForMs: number;
    elapsedMs: number;
    lastNetworkActivityAt?: string;
  };
}

async function waitForNavigationState(input: {
  tabId: number;
  startUrl?: string;
  startDocumentToken?: string;
  waitUntil?: "interactive" | "complete";
  requireUrlChange?: boolean;
  targetUrlIncludes?: string;
  timeoutMs?: number;
  pollIntervalMs?: number;
  requireNetworkIdle?: boolean;
  networkIdleMs?: number;
  maxInflightRequests?: number;
}): Promise<{
  ok: boolean;
  timedOut: boolean;
  elapsedMs: number;
  startUrl?: string;
  error?: string;
  page: PageStateResult;
  network?: {
    idle: boolean;
    timedOut: boolean;
    inflightRequests: number;
    idleForMs: number;
    elapsedMs: number;
    lastNetworkActivityAt?: string;
  };
}> {
  const startedAt = Date.now();
  const timeoutMs = input.timeoutMs ?? 15000;
  const pollIntervalMs = input.pollIntervalMs ?? 250;
  const waitUntil = input.waitUntil ?? "complete";
  let initialPageState: PageStateResult | undefined;
  try {
    initialPageState = await getPageState(input.tabId);
  } catch (_error) {
    initialPageState = undefined;
  }

  const fallbackTab = pickTab(input.tabId);
  const startUrl = input.startUrl ?? initialPageState?.url ?? fallbackTab.url;
  const startDocumentToken = input.startDocumentToken ?? initialPageState?.documentToken;
  let lastPageState: PageStateResult = initialPageState ?? {
    url: startUrl,
    title: fallbackTab.title,
    readyState: "loading",
    documentToken: startDocumentToken ?? "",
  };
  let lastError: string | undefined;

  while (Date.now() - startedAt <= timeoutMs) {
    try {
      lastPageState = await getPageState(input.tabId);
      lastError = undefined;
    } catch (error) {
      lastError = error instanceof Error ? error.message : String(error);
      await sleep(pollIntervalMs);
      continue;
    }
    const urlChanged = lastPageState.url !== startUrl;
    const documentChanged =
      Boolean(startDocumentToken) &&
      lastPageState.documentToken !== startDocumentToken;
    const navigationCondition = input.requireUrlChange
      ? urlChanged
      : urlChanged || documentChanged;
    const readyCondition =
      waitUntil === "interactive"
        ? ["interactive", "complete"].includes(lastPageState.readyState)
        : lastPageState.readyState === "complete";
    const targetUrlCondition =
      !input.targetUrlIncludes ||
      lastPageState.url.includes(input.targetUrlIncludes);

    if (navigationCondition && readyCondition && targetUrlCondition) {
      let network:
        | {
            idle: boolean;
            timedOut: boolean;
            inflightRequests: number;
            idleForMs: number;
            elapsedMs: number;
            lastNetworkActivityAt?: string;
          }
        | undefined;

      if (input.requireNetworkIdle) {
        const remainingTimeoutMs = Math.max(250, timeoutMs - (Date.now() - startedAt));
        network = await waitForNetworkIdle({
          tabId: input.tabId,
          idleMs: input.networkIdleMs ?? 1000,
          timeoutMs: remainingTimeoutMs,
          maxInflightRequests: input.maxInflightRequests ?? 0,
        });
        if (!network.idle) {
          return {
            ok: false,
            timedOut: true,
            elapsedMs: Date.now() - startedAt,
            startUrl,
            page: lastPageState,
            network,
          };
        }
      }

      return {
        ok: true,
        timedOut: false,
        elapsedMs: Date.now() - startedAt,
        startUrl,
        page: lastPageState,
        network,
      };
    }

    await sleep(pollIntervalMs);
  }

  return {
    ok: false,
    timedOut: true,
    elapsedMs: Date.now() - startedAt,
    startUrl,
    page: lastPageState,
    error: lastError,
  };
}

const elementWaitStates = [
  "exists",
  "visible",
  "hidden",
  "enabled",
  "disabled",
  "text_contains",
  "value_contains",
] as const;

async function waitForElementState(input: {
  tabId: number;
  elementId: string;
  state: (typeof elementWaitStates)[number];
  expectedText?: string;
  timeoutMs?: number;
  pollIntervalMs?: number;
}): Promise<{
  ok: boolean;
  timedOut: boolean;
  elapsedMs: number;
  error?: string;
  observed: ElementStateResult;
}> {
  const startedAt = Date.now();
  const timeoutMs = input.timeoutMs ?? 10000;
  const pollIntervalMs = input.pollIntervalMs ?? 250;
  let observed: ElementStateResult = {
    exists: false,
    elementId: input.elementId,
  };
  let lastError: string | undefined;

  const matches = (value: typeof observed): boolean => {
    switch (input.state) {
      case "exists":
        return value.exists;
      case "visible":
        return Boolean(value.exists && value.visible);
      case "hidden":
        return !value.exists || !value.visible;
      case "enabled":
        return Boolean(value.exists && !value.disabled);
      case "disabled":
        return Boolean(value.exists && value.disabled);
      case "text_contains":
        return Boolean(value.exists && input.expectedText && value.text?.includes(input.expectedText));
      case "value_contains":
        return Boolean(value.exists && input.expectedText && value.value?.includes(input.expectedText));
      default:
        return false;
    }
  };

  while (Date.now() - startedAt <= timeoutMs) {
    try {
      observed = await getElementState(input.tabId, input.elementId);
      lastError = undefined;
    } catch (error) {
      lastError = error instanceof Error ? error.message : String(error);
      await sleep(pollIntervalMs);
      continue;
    }
    if (matches(observed)) {
      return {
        ok: true,
        timedOut: false,
        elapsedMs: Date.now() - startedAt,
        observed,
      };
    }
    await sleep(pollIntervalMs);
  }

  return {
    ok: false,
    timedOut: true,
    elapsedMs: Date.now() - startedAt,
    error: lastError,
    observed,
  };
}

async function runPostActionWaits(input: {
  tabId: number;
  startPageState: PageStateResult;
  waitForNavigation?: boolean;
  waitForNetworkIdle?: boolean;
  waitTimeoutMs?: number;
  networkIdleMs?: number;
}): Promise<Record<string, unknown> | undefined> {
  const waits: Record<string, unknown> = {};

  if (input.waitForNavigation) {
    waits.navigation = await waitForNavigationState({
      tabId: input.tabId,
      startUrl: input.startPageState.url,
      startDocumentToken: input.startPageState.documentToken,
      timeoutMs: input.waitTimeoutMs ?? 15000,
      requireUrlChange: false,
      waitUntil: "complete",
      requireNetworkIdle: input.waitForNetworkIdle,
      networkIdleMs: input.networkIdleMs ?? 1000,
    });
  } else if (input.waitForNetworkIdle) {
    waits.network = await waitForNetworkIdle({
      tabId: input.tabId,
      timeoutMs: input.waitTimeoutMs ?? 15000,
      idleMs: input.networkIdleMs ?? 1000,
    });
  }

  return Object.keys(waits).length > 0 ? waits : undefined;
}

server.registerTool(
  "bridge_status",
  {
    description:
      "Show whether the live-browser relay is connected and which browser profile/tabs are currently available.",
  },
  async () => {
    const status = relay.getStatus();
    const debuggerState = status.connected
      ? await relay.call("getDebuggerState")
      : status.debugger;

    return textResult(
      jsonText({
        ...status,
        debugger: debuggerState,
        taskSessions: sessions.list(),
      }),
    );
  },
);

server.registerTool(
  "cdp_status",
  {
    description:
      "Show the current CDP/debugger attachment state for live browser tabs.",
  },
  async () => {
    const status = relay.getStatus();
    const debuggerState = status.connected
      ? await relay.call("getDebuggerState")
      : status.debugger;

    return textResult(jsonText(debuggerState));
  },
);

server.registerTool(
  "list_tabs",
  {
    description: "List all tabs visible to the connected live browser bridge.",
  },
  async () => textResult(jsonText({ tabs: relay.listTabs() })),
);

server.registerTool(
  "list_task_sessions",
  {
    description:
      "List tracked background-safe task sessions. Each session points to a worker tab that is safe to automate instead of the original tab.",
  },
  async () => textResult(jsonText({ taskSessions: sessions.list() })),
);

server.registerTool(
  "start_task_session",
  {
    description:
      "Duplicate a tab into a worker copy, preserve the user's current focus, and create a reusable background-safe task session.",
    inputSchema: {
      tabId: z.number().int().optional(),
      label: z.string().min(1).optional(),
      preserveFocus: z.boolean().optional(),
    },
  },
  async ({ tabId, label, preserveFocus }) => {
    const sourceTab = pickTab(tabId);
    const duplicateResult = (await relay.call("duplicateTab", {
      tabId: sourceTab.tabId,
      preserveFocus: preserveFocus ?? true,
    })) as { tab: BrowserTab };
    const session = sessions.create({
      label,
      sourceTabId: sourceTab.tabId,
      workerTabId: duplicateResult.tab.tabId,
    });
    return textResult(jsonText(session));
  },
);

server.registerTool(
  "close_task_session",
  {
    description:
      "Close a tracked task session. By default this also closes the duplicated worker tab.",
    inputSchema: {
      sessionId: z.string().uuid(),
      closeWorkerTab: z.boolean().optional(),
    },
  },
  async ({ sessionId, closeWorkerTab }) => {
    const session = sessions.require(sessionId);
    if (closeWorkerTab ?? true) {
      if (session.workerTab) {
        await relay.call("closeTab", {
          tabId: session.workerTab.tabId,
        });
      }
    }
    const closed = sessions.close(sessionId);
    return textResult(jsonText(closed));
  },
);

server.registerTool(
  "focus_tab",
  {
    description: "Focus a browser tab by its tab id.",
    inputSchema: {
      tabId: z.number().int(),
    },
  },
  async ({ tabId }) => {
    const result = await relay.call("focusTab", { tabId });
    return textResult(jsonText(result));
  },
);

server.registerTool(
  "duplicate_tab",
  {
    description:
      "Duplicate a tab while preserving the user's current focus, so the copy can be used as a background worker tab.",
    inputSchema: {
      tabId: z.number().int().optional(),
      preserveFocus: z.boolean().optional(),
    },
  },
  async ({ tabId, preserveFocus }) => {
    const tab = pickTab(tabId);
    const result = await relay.call("duplicateTab", {
      tabId: tab.tabId,
      preserveFocus: preserveFocus ?? true,
    });
    return textResult(jsonText(result));
  },
);

server.registerTool(
  "open_tab",
  {
    description: "Open a new tab in the connected browser.",
    inputSchema: {
      url: z.string().url(),
      active: z.boolean().optional(),
    },
  },
  async ({ url, active }) => {
    const result = await relay.call("openTab", { url, active: active ?? true });
    return textResult(jsonText(result));
  },
);

server.registerTool(
  "navigate_tab",
  {
    description:
      "Navigate an existing tab to a URL. If sessionId is provided, navigate the worker tab for that task session.",
    inputSchema: {
      url: z.string().url(),
      tabId: z.number().int().optional(),
      sessionId: z.string().uuid().optional(),
    },
  },
  async ({ url, tabId, sessionId }) => {
    const tab = pickTargetTab({ tabId, sessionId });
    const result = await relay.call("navigateTab", {
      tabId: tab.tabId,
      url,
    });
    return textResult(jsonText(result));
  },
);

server.registerTool(
  "snapshot_tab",
  {
    description:
      "Create a rich structural snapshot of a tab using the real browser DOM, including UI state, forms, images, landmarks, and likely next actions.",
    inputSchema: {
      tabId: z.number().int().optional(),
      sessionId: z.string().uuid().optional(),
      maxElements: z.number().int().min(25).max(500).optional(),
    },
  },
  async ({ tabId, sessionId, maxElements }) => {
    const tab = pickTargetTab({ tabId, sessionId });
    const snapshot = (await relay.call("snapshotTab", {
      tabId: tab.tabId,
      maxElements: maxElements ?? 250,
    })) as PageSnapshot;
    return textResult(jsonText(snapshot));
  },
);

server.registerTool(
  "wait_for_navigation",
  {
    description:
      "Wait for a tab to finish a navigation-like transition by polling URL and document readiness, with optional network-idle confirmation.",
    inputSchema: {
      tabId: z.number().int().optional(),
      sessionId: z.string().uuid().optional(),
      startUrl: z.string().optional(),
      waitUntil: z.enum(["interactive", "complete"]).optional(),
      requireUrlChange: z.boolean().optional(),
      targetUrlIncludes: z.string().min(1).optional(),
      timeoutMs: z.number().int().min(250).max(60000).optional(),
      pollIntervalMs: z.number().int().min(50).max(5000).optional(),
      requireNetworkIdle: z.boolean().optional(),
      networkIdleMs: z.number().int().min(100).max(10000).optional(),
      maxInflightRequests: z.number().int().min(0).max(20).optional(),
    },
  },
  async ({
    tabId,
    sessionId,
    startUrl,
    waitUntil,
    requireUrlChange,
    targetUrlIncludes,
    timeoutMs,
    pollIntervalMs,
    requireNetworkIdle,
    networkIdleMs,
    maxInflightRequests,
  }) => {
    const tab = pickTargetTab({ tabId, sessionId });
    const result = await waitForNavigationState({
      tabId: tab.tabId,
      startUrl,
      waitUntil,
      requireUrlChange,
      targetUrlIncludes,
      timeoutMs,
      pollIntervalMs,
      requireNetworkIdle,
      networkIdleMs,
      maxInflightRequests,
    });
    return textResult(jsonText(result));
  },
);

server.registerTool(
  "wait_for_element_state",
  {
    description:
      "Wait until a previously captured element reaches a target state such as visible, hidden, enabled, disabled, or text/value contains.",
    inputSchema: {
      elementId: z.string().min(1),
      state: z.enum(elementWaitStates),
      expectedText: z.string().optional(),
      tabId: z.number().int().optional(),
      sessionId: z.string().uuid().optional(),
      timeoutMs: z.number().int().min(250).max(60000).optional(),
      pollIntervalMs: z.number().int().min(50).max(5000).optional(),
    },
  },
  async ({
    elementId,
    state,
    expectedText,
    tabId,
    sessionId,
    timeoutMs,
    pollIntervalMs,
  }) => {
    if (
      (state === "text_contains" || state === "value_contains") &&
      !expectedText
    ) {
      throw new Error(
        `State '${state}' requires 'expectedText' to be provided.`,
      );
    }

    const tab = pickTargetTab({ tabId, sessionId });
    const result = await waitForElementState({
      tabId: tab.tabId,
      elementId,
      state,
      expectedText,
      timeoutMs,
      pollIntervalMs,
    });
    return textResult(jsonText(result));
  },
);

server.registerTool(
  "wait_for_network_idle",
  {
    description:
      "Wait until CDP network activity settles for a tab and the number of inflight requests drops below the desired threshold.",
    inputSchema: {
      tabId: z.number().int().optional(),
      sessionId: z.string().uuid().optional(),
      idleMs: z.number().int().min(100).max(10000).optional(),
      timeoutMs: z.number().int().min(250).max(60000).optional(),
      maxInflightRequests: z.number().int().min(0).max(20).optional(),
    },
  },
  async ({ tabId, sessionId, idleMs, timeoutMs, maxInflightRequests }) => {
    const tab = pickTargetTab({ tabId, sessionId });
    const result = await waitForNetworkIdle({
      tabId: tab.tabId,
      idleMs,
      timeoutMs,
      maxInflightRequests,
    });
    return textResult(jsonText(result));
  },
);

server.registerTool(
  "hover_element",
  {
    description: "Move the mouse over an element from a previously captured page snapshot.",
    inputSchema: {
      elementId: z.string().min(1),
      tabId: z.number().int().optional(),
      sessionId: z.string().uuid().optional(),
    },
  },
  async ({ elementId, tabId, sessionId }) => {
    const { tab, target } = await resolveElementTarget({
      elementId,
      tabId,
      sessionId,
    });
    const result = (await relay.call("cdpHover", {
      tabId: tab.tabId,
      x: target.center.x,
      y: target.center.y,
    })) as { hovered: boolean; x: number; y: number; strategy: string };
    return textResult(
      jsonText({
        ...result,
        elementId: target.elementId,
        target,
      }),
    );
  },
);

server.registerTool(
  "click_element",
  {
    description: "Click an element from a previously captured page snapshot.",
    inputSchema: {
      elementId: z.string().min(1),
      tabId: z.number().int().optional(),
      sessionId: z.string().uuid().optional(),
      waitForNavigation: z.boolean().optional(),
      waitForNetworkIdle: z.boolean().optional(),
      waitTimeoutMs: z.number().int().min(250).max(60000).optional(),
      networkIdleMs: z.number().int().min(100).max(10000).optional(),
    },
  },
  async ({
    elementId,
    tabId,
    sessionId,
    waitForNavigation,
    waitForNetworkIdle,
    waitTimeoutMs,
    networkIdleMs,
  }) => {
    const { tab, target } = await resolveElementTarget({
      elementId,
      tabId,
      sessionId,
    });
    const startPageState = await getPageState(tab.tabId);
    const result = (await relay.call("cdpClick", {
      tabId: tab.tabId,
      x: target.center.x,
      y: target.center.y,
      clickCount: 1,
    })) as {
      clicked: boolean;
      x: number;
      y: number;
      clickCount: number;
      strategy: string;
    };
    const waits = await runPostActionWaits({
      tabId: tab.tabId,
      startPageState,
      waitForNavigation,
      waitForNetworkIdle,
      waitTimeoutMs,
      networkIdleMs,
    });
    return textResult(
      jsonText({
        ...result,
        elementId: target.elementId,
        target,
        waits,
      }),
    );
  },
);

server.registerTool(
  "type_into_element",
  {
    description:
      "Type text into an input, textarea, select, or contenteditable element from a page snapshot.",
    inputSchema: {
      elementId: z.string().min(1),
      text: z.string(),
      clearFirst: z.boolean().optional(),
      tabId: z.number().int().optional(),
      sessionId: z.string().uuid().optional(),
      waitForNavigation: z.boolean().optional(),
      waitForNetworkIdle: z.boolean().optional(),
      waitTimeoutMs: z.number().int().min(250).max(60000).optional(),
      networkIdleMs: z.number().int().min(100).max(10000).optional(),
    },
  },
  async ({
    elementId,
    text,
    clearFirst,
    tabId,
    sessionId,
    waitForNavigation,
    waitForNetworkIdle,
    waitTimeoutMs,
    networkIdleMs,
  }) => {
    const { tab, target } = await resolveElementTarget({
      elementId,
      tabId,
      sessionId,
    });
    const startPageState = await getPageState(tab.tabId);

    await relay.call("cdpClick", {
      tabId: tab.tabId,
      x: target.center.x,
      y: target.center.y,
      clickCount: 1,
    });

    const prepared = (await relay.call("prepareElementForTyping", {
      tabId: tab.tabId,
      elementId: target.elementId,
      clearFirst: clearFirst ?? true,
    })) as { prepared: boolean; elementId: string; cleared: boolean; value: string };

    const typed = (await relay.call("cdpTypeText", {
      tabId: tab.tabId,
      text,
    })) as { typed: boolean; textLength: number; strategy: string };
    const observed = await getElementState(tab.tabId, target.elementId);
    const waits = await runPostActionWaits({
      tabId: tab.tabId,
      startPageState,
      waitForNavigation,
      waitForNetworkIdle,
      waitTimeoutMs,
      networkIdleMs,
    });

    return textResult(
      jsonText({
        typed: typed.typed,
        elementId: target.elementId,
        value: observed.value,
        text: observed.text,
        state: observed,
        preparation: prepared,
        cdp: typed,
        target,
        waits,
      }),
    );
  },
);

server.registerTool(
  "select_option",
  {
    description: "Select an option in a select element from a previously captured page snapshot.",
    inputSchema: {
      elementId: z.string().min(1),
      valueOrLabel: z.string().min(1),
      tabId: z.number().int().optional(),
      sessionId: z.string().uuid().optional(),
    },
  },
  async ({ elementId, valueOrLabel, tabId, sessionId }) => {
    const tab = pickTargetTab({ tabId, sessionId });
    const result = await relay.call("selectOption", {
      tabId: tab.tabId,
      elementId,
      valueOrLabel,
    });
    return textResult(jsonText(result));
  },
);

server.registerTool(
  "press_key",
  {
    description: "Send a keyboard key to the current active element in a tab.",
    inputSchema: {
      key: z.string().min(1),
      tabId: z.number().int().optional(),
      sessionId: z.string().uuid().optional(),
    },
  },
  async ({ key, tabId, sessionId }) => {
    const tab = pickTargetTab({ tabId, sessionId });
    const result = await relay.call("cdpPressKey", { tabId: tab.tabId, key });
    return textResult(jsonText(result));
  },
);

server.registerTool(
  "scroll_page",
  {
    description: "Scroll the page by the provided delta values.",
    inputSchema: {
      deltaY: z.number().optional(),
      deltaX: z.number().optional(),
      tabId: z.number().int().optional(),
      sessionId: z.string().uuid().optional(),
    },
  },
  async ({ deltaY, deltaX, tabId, sessionId }) => {
    const tab = pickTargetTab({ tabId, sessionId });
    const result = await relay.call("cdpScroll", {
      tabId: tab.tabId,
      x: 50,
      y: 50,
      deltaY: deltaY ?? 0,
      deltaX: deltaX ?? 0,
    });
    return textResult(jsonText(result));
  },
);

server.registerTool(
  "capture_screenshot",
  {
    description:
      "Capture a screenshot from the real browser. The server stores it locally and returns the filesystem path.",
    inputSchema: {
      tabId: z.number().int().optional(),
      sessionId: z.string().uuid().optional(),
    },
  },
  async ({ tabId, sessionId }) => {
    const tab = pickTargetTab({ tabId, sessionId });
    const result = (await relay.call("captureScreenshot", {
      tabId: tab.tabId,
    })) as {
      dataUrl: string;
      mimeType: string;
      strategy?: string;
      backgroundSafe?: boolean;
    };
    if (!result.dataUrl.startsWith("data:image/png;base64,")) {
      return errorResult(`Unsupported screenshot response: ${result.mimeType}`);
    }

    const screenshotPath = nextScreenshotPath();
    const base64 = result.dataUrl.slice("data:image/png;base64,".length);
    await writeFile(screenshotPath, Buffer.from(base64, "base64"));
    return textResult(
      jsonText({
        tabId: tab.tabId,
        path: screenshotPath,
        mimeType: result.mimeType,
        strategy: result.strategy ?? "unknown",
        backgroundSafe: result.backgroundSafe ?? false,
      }),
    );
  },
);

server.registerTool(
  "evaluate_script",
  {
    description:
      "Run a JavaScript expression in the tab context. Use carefully when structural tools are not enough.",
    inputSchema: {
      expression: z.string().min(1),
      tabId: z.number().int().optional(),
      sessionId: z.string().uuid().optional(),
    },
  },
  async ({ expression, tabId, sessionId }) => {
    const tab = pickTargetTab({ tabId, sessionId });
    const result = await relay.call("evaluateScript", {
      tabId: tab.tabId,
      expression,
    });
    return textResult(jsonText(result));
  },
);

async function main(): Promise<void> {
  await ensureArtifactsDir();
  const transport = new StdioServerTransport();
  await server.connect(transport);
}

main().catch(async (error) => {
  console.error("real-browser-mcp failed to start:", error);
  await relay.close().catch(() => undefined);
  process.exit(1);
});

for (const signal of ["SIGINT", "SIGTERM"] as const) {
  process.on(signal, async () => {
    await relay.close().catch(() => undefined);
    process.exit(0);
  });
}
