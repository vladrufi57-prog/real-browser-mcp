import { writeFile } from "node:fs/promises";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { z } from "zod";
import { LocalBrowserRelay } from "./relay.js";
import { ensureArtifactsDir, errorResult, jsonText, nextScreenshotPath, textResult } from "./results.js";
import { TaskSessionRegistry } from "./task-sessions.js";
import type { BrowserTab, PageSnapshot } from "./types.js";

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
    },
  },
  async ({ elementId, tabId, sessionId }) => {
    const { tab, target } = await resolveElementTarget({
      elementId,
      tabId,
      sessionId,
    });
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
    },
  },
  async ({ elementId, text, clearFirst, tabId, sessionId }) => {
    const { tab, target } = await resolveElementTarget({
      elementId,
      tabId,
      sessionId,
    });

    await relay.call("cdpClick", {
      tabId: tab.tabId,
      x: target.center.x,
      y: target.center.y,
      clickCount: 1,
    });

    const result = (await relay.call("typeIntoElement", {
      tabId: tab.tabId,
      elementId,
      text: "",
      clearFirst: clearFirst ?? true,
    })) as { typed: boolean; elementId: string; value: string };

    const typed = (await relay.call("cdpTypeText", {
      tabId: tab.tabId,
      text,
    })) as { typed: boolean; textLength: number; strategy: string };

    return textResult(
      jsonText({
        ...result,
        cdp: typed,
        elementId: target.elementId,
        target,
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
