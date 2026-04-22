const RELAY_URL = "ws://127.0.0.1:17373";
const RECONNECT_DELAY_MS = 2000;
const RECONNECT_ALARM_NAME = "relay-reconnect";
const HEARTBEAT_INTERVAL_MS = 20000;
const DEBUGGER_PROTOCOL_VERSION = "1.3";
const DEBUGGER_IDLE_DETACH_MS = 15000;

let socket = null;
let reconnectTimer = null;
let heartbeatTimer = null;
const debuggerSessions = new Map();

function buildBrowserInfo() {
  const instanceId = crypto.randomUUID();
  return {
    browserInstanceId: instanceId,
    browserName: navigator.userAgent.includes("YaBrowser")
      ? "Yandex Browser"
      : "Chrome",
    browserVersion: navigator.userAgent,
    profileLabel: "default",
    userAgent: navigator.userAgent,
    connectedAt: new Date().toISOString(),
    capabilities: [
      "tab-discovery",
      "navigation",
      "dom-snapshot",
      "semantic-summary",
      "cdp",
      "background-screenshot",
      "click",
      "type",
      "select",
      "scroll",
      "screenshot",
      "script-eval"
    ]
  };
}

async function listTabs() {
  const tabs = await chrome.tabs.query({});
  return tabs
    .filter((tab) => typeof tab.id === "number")
    .map((tab) => serializeTab(tab));
}

function serializeTab(tab) {
  return {
    tabId: tab.id,
    windowId: tab.windowId,
    active: Boolean(tab.active),
    audible: Boolean(tab.audible),
    discarded: Boolean(tab.discarded),
    favIconUrl: tab.favIconUrl,
    incognito: Boolean(tab.incognito),
    pinned: Boolean(tab.pinned),
    status: tab.status,
    title: tab.title ?? "",
    url: tab.url ?? ""
  };
}

function isDebuggerUnsupportedUrl(url) {
  const value = String(url || "");
  return /^(chrome|chrome-extension|devtools|edge|brave|vivaldi|opera):/i.test(value);
}

async function ensureDebuggerEligible(tabId) {
  const tab = await chrome.tabs.get(tabId);
  if (!tab?.id) {
    throw new Error(`Tab ${tabId} was not found.`);
  }
  if (isDebuggerUnsupportedUrl(tab.url)) {
    throw new Error(`CDP is not available for internal browser page: ${tab.url}`);
  }
  return tab;
}

function scheduleDebuggerDetach(tabId) {
  const state = debuggerSessions.get(tabId);
  if (!state) {
    return;
  }

  if (state.detachTimer) {
    clearTimeout(state.detachTimer);
  }

  state.detachTimer = setTimeout(() => {
    void detachDebugger(tabId).catch(() => undefined);
  }, DEBUGGER_IDLE_DETACH_MS);
}

function touchDebuggerSession(tabId) {
  const state = debuggerSessions.get(tabId);
  if (!state) {
    return;
  }

  state.lastUsedAt = new Date().toISOString();
  scheduleDebuggerDetach(tabId);
}

async function ensureDebuggerAttached(tabId) {
  if (debuggerSessions.has(tabId)) {
    touchDebuggerSession(tabId);
    return debuggerSessions.get(tabId);
  }

  await ensureDebuggerEligible(tabId);

  try {
    await chrome.debugger.attach({ tabId }, DEBUGGER_PROTOCOL_VERSION);
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    throw new Error(
      `Failed to attach CDP debugger to tab ${tabId}. ${message}`,
    );
  }

  const now = new Date().toISOString();
  const state = {
    tabId,
    attachedAt: now,
    lastUsedAt: now,
    networkTracking: false,
    inflightRequests: new Set(),
    lastNetworkActivityAt: now,
    detachTimer: null
  };

  debuggerSessions.set(tabId, state);
  try {
    await chrome.debugger.sendCommand({ tabId }, "Network.enable");
    state.networkTracking = true;
    state.lastNetworkActivityAt = new Date().toISOString();
  } catch (error) {
    debuggerSessions.delete(tabId);
    try {
      await chrome.debugger.detach({ tabId });
    } catch (_detachError) {
    }
    throw error;
  }
  scheduleDebuggerDetach(tabId);
  return state;
}

async function detachDebugger(tabId) {
  const state = debuggerSessions.get(tabId);
  if (!state) {
    return false;
  }

  if (state.detachTimer) {
    clearTimeout(state.detachTimer);
  }

  debuggerSessions.delete(tabId);

  try {
    await chrome.debugger.detach({ tabId });
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    if (!/No tab with given id|Debugger is not attached/i.test(message)) {
      throw error;
    }
  }

  return true;
}

async function debuggerSendCommand(tabId, method, params = {}) {
  await ensureDebuggerAttached(tabId);
  try {
    const result = await chrome.debugger.sendCommand({ tabId }, method, params);
    touchDebuggerSession(tabId);
    return result;
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    throw new Error(`CDP command '${method}' failed for tab ${tabId}. ${message}`);
  }
}

async function ensureNetworkTracking(tabId) {
  const state = await ensureDebuggerAttached(tabId);
  if (state.networkTracking) {
    return state;
  }

  await debuggerSendCommand(tabId, "Network.enable");
  state.networkTracking = true;
  state.lastNetworkActivityAt = new Date().toISOString();
  return state;
}

function serializeDebuggerState() {
  return {
    available: Boolean(chrome.debugger),
    attachedTabs: [...debuggerSessions.values()].map((entry) => ({
      tabId: entry.tabId,
      attachedAt: entry.attachedAt,
      lastUsedAt: entry.lastUsedAt,
      networkTracking: Boolean(entry.networkTracking),
      inflightRequests: entry.inflightRequests?.size || 0,
      lastNetworkActivityAt: entry.lastNetworkActivityAt
    }))
  };
}

async function captureVisibleTabFallback(tabId) {
  const targetTab = await chrome.tabs.get(tabId);
  const currentActiveTabs = await chrome.tabs.query({
    active: true,
    lastFocusedWindow: true
  });
  const currentActiveTab = currentActiveTabs[0];

  await chrome.windows.update(targetTab.windowId, { focused: true });
  await chrome.tabs.update(tabId, { active: true });

  const dataUrl = await chrome.tabs.captureVisibleTab(targetTab.windowId, {
    format: "png"
  });

  if (typeof currentActiveTab?.id === "number") {
    await chrome.windows.update(currentActiveTab.windowId, { focused: true });
    await chrome.tabs.update(currentActiveTab.id, { active: true });
  }

  return {
    dataUrl,
    mimeType: "image/png",
    strategy: "tabs-capture-visible-tab",
    backgroundSafe: false
  };
}

function send(message) {
  if (!socket || socket.readyState !== WebSocket.OPEN) {
    return;
  }
  socket.send(JSON.stringify(message));
}

function startHeartbeat() {
  if (heartbeatTimer) {
    clearInterval(heartbeatTimer);
  }
  heartbeatTimer = setInterval(() => {
    send({
      type: "pong",
      at: new Date().toISOString()
    });
  }, HEARTBEAT_INTERVAL_MS);
}

function stopHeartbeat() {
  if (!heartbeatTimer) {
    return;
  }
  clearInterval(heartbeatTimer);
  heartbeatTimer = null;
}

async function sendHello() {
  send({
    type: "hello",
    browser: buildBrowserInfo(),
    tabs: await listTabs()
  });
}

async function broadcastTabs() {
  send({
    type: "tabs_updated",
    tabs: await listTabs()
  });
}

async function focusTab(tabId) {
  const tab = await chrome.tabs.get(tabId);
  await chrome.windows.update(tab.windowId, { focused: true });
  await chrome.tabs.update(tabId, { active: true });
  return { focused: true, tabId };
}

async function openTab(url, active = true) {
  const tab = await chrome.tabs.create({ url, active });
  return serializeTab(tab);
}

async function duplicateTab(tabId, preserveFocus = true) {
  const currentActiveTabs = await chrome.tabs.query({
    active: true,
    lastFocusedWindow: true
  });
  const currentActiveTab = currentActiveTabs[0];
  const duplicated = await chrome.tabs.duplicate(tabId);

  if (!duplicated?.id) {
    throw new Error(`Failed to duplicate tab ${tabId}.`);
  }

  if (preserveFocus && typeof currentActiveTab?.id === "number") {
    await chrome.windows.update(currentActiveTab.windowId, { focused: true });
    await chrome.tabs.update(currentActiveTab.id, { active: true });
  }

  return {
    duplicatedFromTabId: tabId,
    preservedFocus: Boolean(preserveFocus && currentActiveTab),
    tab: serializeTab(duplicated)
  };
}

async function closeTab(tabId) {
  await chrome.tabs.remove(tabId);
  return {
    closed: true,
    tabId
  };
}

async function navigateTab(tabId, url) {
  await ensureNetworkTracking(tabId);
  const tab = await chrome.tabs.update(tabId, { url });
  return {
    tabId: tab.id,
    url: tab.url,
    title: tab.title,
    status: tab.status
  };
}

async function runInTab(tabId, func, args = []) {
  const [injection] = await chrome.scripting.executeScript({
    target: { tabId },
    world: "MAIN",
    func,
    args
  });
  return injection?.result;
}

function snapshotPage(maxElements = 250) {
  const GLOBAL_KEY = "__REAL_BROWSER_MCP__";
  const state = window[GLOBAL_KEY] || (window[GLOBAL_KEY] = { counter: 1, contextCounter: 1 });
  if (typeof state.contextCounter !== "number") {
    state.contextCounter = 1;
  }
  if (!state.helpers || state.helpers.version !== 1) {
    const getElementStyle = (element) => {
      return element.ownerDocument.defaultView?.getComputedStyle?.(element) || window.getComputedStyle(element);
    };

    const getElementAbsoluteRect = (element) => {
      const rect = element.getBoundingClientRect();
      let x = rect.left;
      let y = rect.top;
      let currentWindow = element.ownerDocument.defaultView;

      while (currentWindow && currentWindow !== window) {
        const frameElement = currentWindow.frameElement;
        if (!frameElement) {
          break;
        }

        const frameRect = frameElement.getBoundingClientRect();
        x += frameRect.left;
        y += frameRect.top;
        currentWindow = frameElement.ownerDocument.defaultView;
      }

      return {
        x,
        y,
        width: rect.width,
        height: rect.height
      };
    };

    const scrollElementIntoViewAcrossContexts = (element) => {
      element.scrollIntoView({ block: "center", inline: "center", behavior: "instant" });

      let currentWindow = element.ownerDocument.defaultView;
      while (currentWindow && currentWindow !== window) {
        const frameElement = currentWindow.frameElement;
        if (!frameElement) {
          break;
        }

        frameElement.scrollIntoView({ block: "center", inline: "center", behavior: "instant" });
        currentWindow = frameElement.ownerDocument.defaultView;
      }
    };

    const findElementById = (elementId) => {
      const selector = `[data-real-browser-mcp-id="${CSS.escape(elementId)}"]`;
      const visitedRoots = new WeakSet();

      const search = (root) => {
        if (!root || visitedRoots.has(root)) {
          return null;
        }
        visitedRoots.add(root);

        if (typeof root.querySelector === "function") {
          const directMatch = root.querySelector(selector);
          if (directMatch) {
            return directMatch;
          }
        }

        const rootDocument = root instanceof Document ? root : root.ownerDocument || document;
        const walker = rootDocument.createTreeWalker(root, NodeFilter.SHOW_ELEMENT);

        while (walker.nextNode()) {
          const element = walker.currentNode;
          if (!(element instanceof HTMLElement)) {
            continue;
          }

          if (element.shadowRoot?.mode === "open") {
            const shadowMatch = search(element.shadowRoot);
            if (shadowMatch) {
              return shadowMatch;
            }
          }

          if (element.tagName !== "IFRAME" && element.tagName !== "FRAME") {
            continue;
          }

          try {
            const childDocument = element.contentDocument;
            if (!childDocument?.documentElement) {
              continue;
            }

            const frameMatch = search(childDocument);
            if (frameMatch) {
              return frameMatch;
            }
          } catch (_error) {
          }
        }

        return null;
      };

      return search(document);
    };

    state.helpers = {
      version: 1,
      findElementById,
      getElementStyle,
      getElementAbsoluteRect,
      scrollElementIntoViewAcrossContexts
    };
  }

  const topWindow = window.top || window;
  const landmarkRoles = new Set([
    "banner",
    "complementary",
    "contentinfo",
    "dialog",
    "form",
    "main",
    "navigation",
    "region",
    "search"
  ]);
  const ctaPatterns = [
    { pattern: /(sign in|log in|login|continue|next|submit|save|confirm|search)/i, boost: 24 },
    { pattern: /(buy|checkout|pay|add to cart|book|reserve|start)/i, boost: 18 },
    { pattern: /(accept|allow|agree|close|done|finish)/i, boost: 12 }
  ];
  const selectors = [
    "a[href]",
    "button",
    "input",
    "textarea",
    "select",
    "[role]",
    "[contenteditable='true']",
    "[contenteditable='']",
    "[tabindex]",
    "summary",
    "details",
    "img",
    "canvas",
    "video",
    "h1,h2,h3,h4,h5,h6",
    "p",
    "li"
  ].join(",");
  const overlaySelector = [
    "dialog[open]",
    "[role='dialog']",
    "[aria-modal='true']",
    "[role='menu']",
    "[role='listbox']",
    "[role='tooltip']",
    "[popover]"
  ].join(",");
  const editorSelector = [
    "textarea",
    "input:not([type='hidden'])",
    "[contenteditable='true']",
    "[contenteditable='']",
    "[role='textbox']",
    "[role='searchbox']"
  ].join(",");
  const tableSelector = [
    "table",
    "[role='table']",
    "[role='grid']"
  ].join(",");
  const virtualizedSelector = [
    "[aria-rowcount]",
    "[aria-setsize]",
    "[data-virtualized]",
    "[data-testid*='virtual']",
    "[class*='virtualized']"
  ].join(",");

  const contextRecords = [];
  const contextByRoot = new WeakMap();
  const contextByDocument = new WeakMap();
  const queuedRoots = new WeakSet();
  const visitedDocuments = new WeakSet();
  const visitedFrameElements = new WeakSet();
  const seenSnapshotElements = new WeakSet();
  const rootQueue = [];
  const documentTextParts = [];

  const normalizeText = (value) =>
    String(value || "")
      .replace(/\s+/g, " ")
      .trim();

  const safeSlice = (value, limit) => normalizeText(value).slice(0, limit);

  const toBox = (rect) => ({
    x: Math.round(rect.x),
    y: Math.round(rect.y),
    width: Math.round(rect.width),
    height: Math.round(rect.height)
  });

  const ensureElementId = (element) => {
    if (!element.dataset.realBrowserMcpId) {
      element.dataset.realBrowserMcpId = `rbmcp-${state.counter++}`;
    }
    return element.dataset.realBrowserMcpId;
  };

  const createContextRecord = (input) => ({
    contextId: input.contextId || `ctx-${state.contextCounter++}`,
    parentContextId: input.parentContextId,
    kind: input.kind,
    frameElementId: input.frameElementId,
    hostElementId: input.hostElementId,
    url: input.url || "about:blank",
    title: input.title || undefined,
    name: input.name || undefined,
    sameOrigin: Boolean(input.sameOrigin),
    root: Boolean(input.root),
    rootNode: input.rootNode || null,
    document: input.document || null
  });

  const serializeContext = (record) => ({
    contextId: record.contextId,
    parentContextId: record.parentContextId,
    kind: record.kind,
    frameElementId: record.frameElementId,
    hostElementId: record.hostElementId,
    url: record.url,
    title: record.title,
    name: record.name,
    sameOrigin: record.sameOrigin,
    root: record.root
  });

  const registerContext = (input) => {
    if (input.rootNode && contextByRoot.has(input.rootNode)) {
      return contextByRoot.get(input.rootNode);
    }

    const record = createContextRecord(input);
    contextRecords.push(record);

    if (record.rootNode) {
      contextByRoot.set(record.rootNode, record);
    }
    if (record.document) {
      contextByDocument.set(record.document, record);
    }

    return record;
  };

  const queueRoot = (root, context) => {
    if (!root || queuedRoots.has(root)) {
      return;
    }
    queuedRoots.add(root);
    rootQueue.push({ root, context });
    scanRootForNestedContexts(root, context);
  };

  const getRootDocument = (root) => {
    if (root instanceof Document) {
      return root;
    }
    return root.ownerDocument || document;
  };

  const getAbsoluteRect = (element) => {
    const rect = element.getBoundingClientRect();
    let x = rect.left;
    let y = rect.top;
    let currentWindow = element.ownerDocument.defaultView;

    while (currentWindow && currentWindow !== topWindow) {
      const frameElement = currentWindow.frameElement;
      if (!frameElement) {
        break;
      }

      const frameRect = frameElement.getBoundingClientRect();
      x += frameRect.left;
      y += frameRect.top;
      currentWindow = frameElement.ownerDocument.defaultView;
    }

    return {
      x,
      y,
      width: rect.width,
      height: rect.height
    };
  };

  const resolveContextForElement = (element) => {
    const root = element.getRootNode?.();
    if (root && contextByRoot.has(root)) {
      return contextByRoot.get(root);
    }
    if (contextByDocument.has(element.ownerDocument)) {
      return contextByDocument.get(element.ownerDocument);
    }
    return contextRecords[0];
  };

  const bindElementToContext = (element, context) => {
    if (!context) {
      return;
    }
    ensureElementId(element);
    element.dataset.realBrowserMcpContextId = context.contextId;
  };

  const getStyleForElement = (element) =>
    element.ownerDocument.defaultView?.getComputedStyle?.(element) || window.getComputedStyle(element);

  const isVisible = (element, style, rect) => {
    if (!rect || rect.width <= 0 || rect.height <= 0) {
      return false;
    }
    if (!style) {
      return true;
    }
    if (style.display === "none" || style.visibility === "hidden") {
      return false;
    }
    return Number(style.opacity || "1") > 0.02;
  };

  const queryAllFromRoot = (root, selector) => {
    if (!root?.querySelectorAll) {
      return [];
    }
    return [...root.querySelectorAll(selector)];
  };

  const getText = (element, limit = 400) => {
    const text = normalizeText(element.innerText || element.textContent || element.value || "");
    return text.slice(0, limit);
  };

  const getDescribedByText = (element) => {
    const describedBy = element.getAttribute("aria-describedby");
    if (!describedBy) {
      return "";
    }

    const elementDocument = element.ownerDocument;
    return normalizeText(
      describedBy
        .split(/\s+/)
        .map((id) => elementDocument.getElementById(id)?.innerText || elementDocument.getElementById(id)?.textContent || "")
        .join(" ")
    );
  };

  const getLabel = (element) => {
    const aria = element.getAttribute("aria-label");
    if (aria) {
      return normalizeText(aria);
    }

    const labelledBy = element.getAttribute("aria-labelledby");
    if (labelledBy) {
      const parts = labelledBy
        .split(/\s+/)
        .map((id) => normalizeText(element.ownerDocument.getElementById(id)?.innerText || element.ownerDocument.getElementById(id)?.textContent || ""))
        .filter(Boolean);
      if (parts.length) {
        return parts.join(" ");
      }
    }

    if (element.labels?.length) {
      return [...element.labels]
        .map((label) => normalizeText(label.innerText || label.textContent || ""))
        .filter(Boolean)
        .join(" ");
    }

    const fieldWrapperLabel = element.closest("label");
    if (fieldWrapperLabel) {
      const wrapperText = normalizeText(fieldWrapperLabel.innerText || fieldWrapperLabel.textContent || "");
      if (wrapperText) {
        return wrapperText;
      }
    }

    return normalizeText(
      element.getAttribute("title") ||
      element.getAttribute("placeholder") ||
      element.getAttribute("alt") ||
      ""
    );
  };

  const getDescription = (element) => {
    const ariaDescription = element.getAttribute("aria-description");
    if (ariaDescription) {
      return normalizeText(ariaDescription).slice(0, 200);
    }

    const described = getDescribedByText(element);
    if (described) {
      return described.slice(0, 200);
    }

    const title = element.getAttribute("title");
    if (title) {
      return normalizeText(title).slice(0, 200);
    }

    return undefined;
  };

  const getRole = (element) => {
    const explicitRole = element.getAttribute("role");
    if (explicitRole) {
      return explicitRole;
    }

    if (element.tagName === "A") {
      return "link";
    }
    if (element.tagName === "BUTTON") {
      return "button";
    }
    if (element.tagName === "SELECT") {
      return "combobox";
    }
    if (element.tagName === "TEXTAREA") {
      return "textbox";
    }
    if (element.tagName === "INPUT") {
      const type = (element.getAttribute("type") || "text").toLowerCase();
      if (type === "search") {
        return "searchbox";
      }
      if (["button", "submit", "reset"].includes(type)) {
        return "button";
      }
      if (["checkbox", "radio"].includes(type)) {
        return type;
      }
      return "textbox";
    }
    return element.tagName.toLowerCase();
  };

  const buildElementSnapshot = (element) => {
    const context = resolveContextForElement(element);
    bindElementToContext(element, context);
    const rect = getAbsoluteRect(element);
    const style = getStyleForElement(element);
    const visible = isVisible(element, style, rect);
    const label = getLabel(element).slice(0, 200);
    const text = getText(element);
    const type = element.getAttribute("type") || undefined;
    const description = getDescription(element);
    const value =
      typeof element.value === "string"
        ? normalizeText(element.value).slice(0, 200)
        : undefined;

    if (!visible && !text && !label && !value) {
      return null;
    }

    return {
      id: ensureElementId(element),
      contextId: context?.contextId || "ctx-unknown",
      contextType: context?.kind || "top-document",
      role: getRole(element),
      tagName: element.tagName.toLowerCase(),
      text,
      label,
      description,
      placeholder: element.getAttribute("placeholder") || undefined,
      type,
      value,
      href: element.getAttribute("href") || undefined,
      src: element.getAttribute("src") || undefined,
      alt: element.getAttribute("alt") || undefined,
      visible,
      disabled:
        Boolean(("disabled" in element && element.disabled) || element.getAttribute("aria-disabled") === "true"),
      editable:
        element.isContentEditable ||
        ["INPUT", "TEXTAREA", "SELECT"].includes(element.tagName),
      checked:
        typeof element.checked === "boolean" ? element.checked : undefined,
      selected:
        typeof element.selected === "boolean" ? element.selected : undefined,
      bbox: toBox(rect)
    };
  };

  function visitDocument(doc, meta) {
    if (!doc || visitedDocuments.has(doc)) {
      return;
    }

    visitedDocuments.add(doc);
    documentTextParts.push(safeSlice(doc.body?.innerText || doc.documentElement?.innerText || "", 4000));

    const context = registerContext({
      rootNode: doc,
      document: doc,
      parentContextId: meta.parentContextId,
      kind: meta.kind,
      frameElementId: meta.frameElementId,
      hostElementId: meta.hostElementId,
      url: meta.url || doc.location?.href || "about:blank",
      title: meta.title || doc.title || undefined,
      name: meta.name,
      sameOrigin: meta.sameOrigin,
      root: meta.root
    });

    queueRoot(doc, context);
  }

  function scanRootForNestedContexts(root, parentContext) {
    const rootDocument = getRootDocument(root);
    const treeWalker = rootDocument.createTreeWalker(root, NodeFilter.SHOW_ELEMENT);

    while (treeWalker.nextNode()) {
      const element = treeWalker.currentNode;
      if (!(element instanceof HTMLElement)) {
        continue;
      }

      if (element.shadowRoot?.mode === "open") {
        const hostElementId = ensureElementId(element);
        const shadowContext = registerContext({
          rootNode: element.shadowRoot,
          document: element.ownerDocument,
          parentContextId: parentContext.contextId,
          kind: "shadow-root",
          hostElementId,
          url: parentContext.url,
          title: parentContext.title,
          sameOrigin: true,
          root: false
        });
        queueRoot(element.shadowRoot, shadowContext);
      }

      if (visitedFrameElements.has(element)) {
        continue;
      }

      if (element.tagName !== "IFRAME" && element.tagName !== "FRAME") {
        continue;
      }

      visitedFrameElements.add(element);
      const frameElementId = ensureElementId(element);
      const frameName = safeSlice(element.getAttribute("name") || element.getAttribute("title") || "", 120) || undefined;

      try {
        const childDocument = element.contentDocument;
        if (childDocument?.documentElement) {
          visitDocument(childDocument, {
            parentContextId: parentContext.contextId,
            kind: "iframe-document",
            frameElementId,
            name: frameName,
            sameOrigin: true,
            root: false
          });
          continue;
        }
      } catch (_error) {
      }

      registerContext({
        parentContextId: parentContext.contextId,
        kind: "iframe-document",
        frameElementId,
        url: element.getAttribute("src") || "about:blank",
        title: element.getAttribute("title") || undefined,
        name: frameName,
        sameOrigin: false,
        root: false
      });
    }
  }

  visitDocument(document, {
    kind: "top-document",
    url: location.href,
    title: document.title,
    sameOrigin: true,
    root: true
  });

  const elements = [];
  for (const { root } of rootQueue) {
    for (const element of queryAllFromRoot(root, selectors)) {
      if (elements.length >= maxElements) {
        break;
      }
      if (seenSnapshotElements.has(element)) {
        continue;
      }
      const snapshot = buildElementSnapshot(element);
      if (!snapshot) {
        continue;
      }
      seenSnapshotElements.add(element);
      elements.push(snapshot);
    }

    if (elements.length >= maxElements) {
      break;
    }
  }

  const headings = [];
  for (const { root } of rootQueue) {
    for (const heading of queryAllFromRoot(root, "h1,h2,h3,h4,h5,h6")) {
      const snapshot = buildElementSnapshot(heading);
      if (!snapshot || !snapshot.visible || !snapshot.text) {
        continue;
      }
      headings.push({
        elementId: snapshot.id,
        level: Number(heading.tagName.slice(1)),
        text: snapshot.text.slice(0, 250),
        bbox: snapshot.bbox
      });
      if (headings.length >= 20) {
        break;
      }
    }
    if (headings.length >= 20) {
      break;
    }
  }

  const forms = [];
  for (const { root } of rootQueue) {
    for (const form of queryAllFromRoot(root, "form")) {
      const formSnapshot = buildElementSnapshot(form);
      if (!formSnapshot) {
        continue;
      }

      const fields = queryAllFromRoot(form, "input, textarea, select, [contenteditable='true'], [contenteditable=''], [role='textbox'], [role='searchbox']")
        .map((field) => {
          const fieldSnapshot = buildElementSnapshot(field);
          if (!fieldSnapshot) {
            return null;
          }

          const options = field.tagName === "SELECT"
            ? [...field.options]
                .map((option) => normalizeText(option.textContent || option.label || ""))
                .filter(Boolean)
                .slice(0, 30)
            : undefined;

          return {
            elementId: fieldSnapshot.id,
            role: fieldSnapshot.role,
            type: field.getAttribute("type") || undefined,
            label: fieldSnapshot.label,
            placeholder: field.getAttribute("placeholder") || undefined,
            value:
              typeof field.value === "string"
                ? normalizeText(field.value).slice(0, 200)
                : undefined,
            required: Boolean(field.required || field.getAttribute("aria-required") === "true"),
            invalid: Boolean(field.matches?.(":invalid") || field.getAttribute("aria-invalid") === "true"),
            disabled:
              Boolean(("disabled" in field && field.disabled) || field.getAttribute("aria-disabled") === "true"),
            checked:
              typeof field.checked === "boolean" ? field.checked : undefined,
            options
          };
        })
        .filter(Boolean)
        .slice(0, 20);

      const submitButtons = queryAllFromRoot(
        form,
        "button, input[type='submit'], input[type='button']"
      )
        .map((button) => {
          const buttonSnapshot = buildElementSnapshot(button);
          if (!buttonSnapshot) {
            return null;
          }
          return {
            elementId: buttonSnapshot.id,
            text: buttonSnapshot.text.slice(0, 120),
            label: buttonSnapshot.label.slice(0, 120),
            disabled:
              Boolean(("disabled" in button && button.disabled) || button.getAttribute("aria-disabled") === "true")
          };
        })
        .filter(Boolean)
        .slice(0, 8);

      if (!fields.length && !submitButtons.length) {
        continue;
      }

      const formName = safeSlice(
        form.getAttribute("aria-label") ||
          form.querySelector("legend")?.innerText ||
          form.querySelector("h1,h2,h3,h4,h5,h6")?.innerText ||
          "",
        200
      );

      forms.push({
        elementId: formSnapshot.id,
        contextId: formSnapshot.contextId,
        name: formName,
        method: (form.getAttribute("method") || "get").toLowerCase(),
        action: form.getAttribute("action") || undefined,
        fields,
        submitButtons
      });

      if (forms.length >= 12) {
        break;
      }
    }
    if (forms.length >= 12) {
      break;
    }
  }

  const images = [];
  for (const { root } of rootQueue) {
    for (const element of queryAllFromRoot(root, "img, canvas, video")) {
      const imageSnapshot = buildElementSnapshot(element);
      if (!imageSnapshot || !imageSnapshot.visible) {
        continue;
      }

      const kind = element.tagName.toLowerCase();
      const caption = safeSlice(
        element.closest("figure")?.querySelector("figcaption")?.innerText ||
          element.getAttribute("aria-description") ||
          "",
        200
      );

      images.push({
        elementId: imageSnapshot.id,
        contextId: imageSnapshot.contextId,
        kind,
        alt: safeSlice(element.getAttribute("alt") || element.getAttribute("aria-label") || "", 200),
        title: safeSlice(element.getAttribute("title") || "", 200) || undefined,
        src: element.getAttribute("src") || undefined,
        caption: caption || undefined,
        loaded:
          kind === "img"
            ? Boolean(element.complete && element.naturalWidth > 0)
            : true,
        bbox: imageSnapshot.bbox
      });

      if (images.length >= 24) {
        break;
      }
    }
    if (images.length >= 24) {
      break;
    }
  }

  const landmarks = [];
  for (const { root } of rootQueue) {
    for (const element of queryAllFromRoot(root, "main, nav, header, footer, aside, section, [role]")) {
      const landmarkSnapshot = buildElementSnapshot(element);
      if (!landmarkSnapshot) {
        continue;
      }
      if (!landmarkRoles.has(landmarkSnapshot.role)) {
        continue;
      }
      if (!landmarkSnapshot.text && !landmarkSnapshot.label) {
        continue;
      }

      landmarks.push({
        elementId: landmarkSnapshot.id,
        contextId: landmarkSnapshot.contextId,
        role: landmarkSnapshot.role,
        label: landmarkSnapshot.label.slice(0, 200),
        textExcerpt: landmarkSnapshot.text.slice(0, 250)
      });

      if (landmarks.length >= 24) {
        break;
      }
    }
    if (landmarks.length >= 24) {
      break;
    }
  }

  const isPopoverOpen = (element) => {
    if (!element.hasAttribute("popover")) {
      return false;
    }
    try {
      return element.matches(":popover-open");
    } catch (_error) {
      return !element.hasAttribute("hidden");
    }
  };

  const overlayKind = (element) => {
    const role = element.getAttribute("role");
    if (element.tagName === "DIALOG" || role === "dialog" || element.getAttribute("aria-modal") === "true") {
      return "dialog";
    }
    if (role === "menu") {
      return "menu";
    }
    if (role === "listbox") {
      return "listbox";
    }
    if (role === "tooltip") {
      return "tooltip";
    }
    if (element.hasAttribute("popover")) {
      return "popover";
    }
    return "dialog";
  };

  const overlays = [];
  for (const { root } of rootQueue) {
    for (const element of queryAllFromRoot(root, overlaySelector)) {
      const snapshot = buildElementSnapshot(element);
      if (!snapshot || !snapshot.visible) {
        continue;
      }
      const kind = overlayKind(element);
      if (kind === "popover" && !isPopoverOpen(element)) {
        continue;
      }

      overlays.push({
        elementId: snapshot.id,
        contextId: snapshot.contextId,
        kind,
        label: snapshot.label.slice(0, 200),
        textExcerpt: snapshot.text.slice(0, 300),
        modal: element.tagName === "DIALOG" || element.getAttribute("aria-modal") === "true",
        bbox: snapshot.bbox
      });

      if (overlays.length >= 20) {
        break;
      }
    }
    if (overlays.length >= 20) {
      break;
    }
  }

  const editors = [];
  for (const { root } of rootQueue) {
    for (const element of queryAllFromRoot(root, editorSelector)) {
      const snapshot = buildElementSnapshot(element);
      if (!snapshot || !snapshot.visible || (!snapshot.editable && !["textbox", "searchbox"].includes(snapshot.role))) {
        continue;
      }

      editors.push({
        elementId: snapshot.id,
        contextId: snapshot.contextId,
        kind:
          snapshot.role === "searchbox"
            ? "searchbox"
            : element.isContentEditable
              ? "contenteditable"
              : "textbox",
        label: snapshot.label,
        value: snapshot.value || snapshot.text || undefined,
        multiline: element.tagName === "TEXTAREA" || element.getAttribute("aria-multiline") === "true" || element.isContentEditable,
        focused: document.activeElement === element || element.ownerDocument.activeElement === element,
        bbox: snapshot.bbox
      });

      if (editors.length >= 24) {
        break;
      }
    }
    if (editors.length >= 24) {
      break;
    }
  }

  const tables = [];
  for (const { root } of rootQueue) {
    for (const element of queryAllFromRoot(root, tableSelector)) {
      const snapshot = buildElementSnapshot(element);
      if (!snapshot || !snapshot.visible) {
        continue;
      }

      const headers = queryAllFromRoot(element, "th, [role='columnheader']")
        .map((header) => safeSlice(header.innerText || header.textContent || "", 120))
        .filter(Boolean)
        .slice(0, 12);
      const rowCandidates = queryAllFromRoot(element, "tr, [role='row']");

      tables.push({
        elementId: snapshot.id,
        contextId: snapshot.contextId,
        role: snapshot.role,
        label: snapshot.label,
        caption: safeSlice(
          element.querySelector("caption")?.innerText ||
            element.getAttribute("aria-label") ||
            "",
          200
        ) || undefined,
        columnHeaders: headers,
        rowCount: rowCandidates.length,
        visibleRowCount: rowCandidates.filter((row) => {
          const rowSnapshot = buildElementSnapshot(row);
          return Boolean(rowSnapshot?.visible);
        }).length,
        bbox: snapshot.bbox
      });

      if (tables.length >= 16) {
        break;
      }
    }
    if (tables.length >= 16) {
      break;
    }
  }

  const hasVisibleVirtualizedList = rootQueue.some(({ root }) =>
    queryAllFromRoot(root, virtualizedSelector).some((element) => {
      const snapshot = buildElementSnapshot(element);
      return Boolean(snapshot?.visible);
    })
  );

  const interactiveElements = elements.filter((element) => {
    if (!element.visible || element.disabled) {
      return false;
    }

    return (
      ["button", "link", "textbox", "searchbox", "combobox", "checkbox", "radio"].includes(element.role) ||
      element.editable
    );
  });

  const primaryActions = interactiveElements
    .map((element) => {
      const combined = normalizeText(`${element.label} ${element.text}`.slice(0, 240));
      let score = 0;
      let reason = "visible interactive element";
      let kind = "click";

      if (element.editable && element.role !== "combobox") {
        kind = "type";
        score += 20;
        reason = "editable field";
      }

      if (element.role === "combobox") {
        kind = "select";
        score += 22;
        reason = "select control";
      }

      if (element.role === "button") {
        score += 35;
        reason = "button";
      } else if (element.role === "link") {
        score += 24;
        reason = "link";
      }

      if (element.bbox.y >= 0 && element.bbox.y <= window.innerHeight) {
        score += 10;
      }

      if (element.type === "password") {
        score += 12;
        kind = "type";
        reason = "password field";
      }

      for (const rule of ctaPatterns) {
        if (rule.pattern.test(combined)) {
          score += rule.boost;
        }
      }

      return {
        elementId: element.id,
        kind,
        text: element.text,
        label: element.label,
        reason,
        score
      };
    })
    .sort((left, right) => right.score - left.score)
    .slice(0, 15);

  const resolveDeepActiveElement = (startDocument) => {
    let active = startDocument.activeElement instanceof HTMLElement ? startDocument.activeElement : null;
    while (active) {
      if (active.shadowRoot?.activeElement instanceof HTMLElement) {
        active = active.shadowRoot.activeElement;
        continue;
      }

      if ((active.tagName === "IFRAME" || active.tagName === "FRAME") && active.contentDocument?.activeElement instanceof HTMLElement) {
        active = active.contentDocument.activeElement;
        continue;
      }
      break;
    }
    return active;
  };

  const activeElement = resolveDeepActiveElement(document);
  const activeSnapshot = activeElement ? buildElementSnapshot(activeElement) : null;
  const selectionText = safeSlice(window.getSelection?.()?.toString() || "", 500);
  const bodyText = normalizeText(documentTextParts.filter(Boolean).join(" "));
  const hasLoginForm = forms.some((form) =>
    form.fields.some((field) => field.type === "password")
  );
  const hasSearch =
    forms.some((form) =>
      form.fields.some((field) =>
        field.type === "search" || /search/i.test(`${field.label} ${field.placeholder || ""}`)
      )
    ) ||
    rootQueue.some(({ root }) => queryAllFromRoot(root, "input[type='search'], [role='search'], [role='searchbox']").length > 0);
  const hasCookieBanner =
    /\bcookie(s)?\b/i.test(bodyText) &&
    /\b(accept|allow|agree|consent|reject|manage)\b/i.test(bodyText);

  return {
    capturedAt: new Date().toISOString(),
    title: document.title,
    url: location.href,
    viewport: {
      width: window.innerWidth,
      height: window.innerHeight
    },
    scroll: {
      x: window.scrollX,
      y: window.scrollY
    },
    state: {
      readyState: document.readyState,
      hasDialog: overlays.some((overlay) => overlay.kind === "dialog"),
      hasLoginForm,
      hasSearch,
      hasCookieBanner,
      hasMenu: overlays.some((overlay) => overlay.kind === "menu" || overlay.kind === "listbox"),
      hasPopover: overlays.some((overlay) => overlay.kind === "popover" || overlay.kind === "tooltip"),
      hasTable: tables.length > 0,
      hasRichEditor: editors.some((editor) => editor.kind === "contenteditable" || editor.multiline),
      hasVirtualizedList: hasVisibleVirtualizedList,
      hasIframes: contextRecords.some((context) => context.kind === "iframe-document"),
      hasShadowDom: contextRecords.some((context) => context.kind === "shadow-root"),
      axTreeAvailable: false,
      domSnapshotAvailable: false,
      activeElementId: activeSnapshot?.id,
      activeElementRole: activeSnapshot?.role,
      activeElementLabel: activeSnapshot?.label || activeSnapshot?.text || undefined,
      selectionText: selectionText || undefined
    },
    documentTextExcerpt: bodyText.slice(0, 12000),
    contexts: contextRecords.map(serializeContext),
    headings,
    forms,
    images,
    landmarks,
    overlays,
    editors,
    tables,
    accessibility: {
      available: false,
      nodeCount: 0,
      trackedElements: [],
      interestingNodes: []
    },
    layout: {
      available: false,
      documentCount: 0,
      layoutNodeCount: 0,
      textBoxCount: 0,
      frameIds: [],
      trackedElements: []
    },
    primaryActions,
    elements
  };
}

function protocolString(strings, index) {
  if (!Array.isArray(strings) || typeof index !== "number" || index < 0) {
    return "";
  }
  return String(strings[index] || "");
}

function protocolAttributesToRecord(strings, attributeIndexes) {
  const record = {};
  if (!Array.isArray(attributeIndexes)) {
    return record;
  }

  for (let index = 0; index < attributeIndexes.length; index += 2) {
    const key = protocolString(strings, attributeIndexes[index]);
    if (!key) {
      continue;
    }
    record[key] = protocolString(strings, attributeIndexes[index + 1]);
  }

  return record;
}

function protocolRareStringMap(strings, rareData) {
  const map = new Map();
  if (!rareData?.index || !rareData?.value) {
    return map;
  }

  rareData.index.forEach((nodeIndex, index) => {
    map.set(nodeIndex, protocolString(strings, rareData.value[index]));
  });
  return map;
}

function protocolRareIntegerMap(rareData) {
  const map = new Map();
  if (!rareData?.index || !rareData?.value) {
    return map;
  }

  rareData.index.forEach((nodeIndex, index) => {
    map.set(nodeIndex, rareData.value[index]);
  });
  return map;
}

function protocolRareBooleanSet(rareData) {
  return new Set(Array.isArray(rareData?.index) ? rareData.index : []);
}

function protocolBoundsToBox(bounds) {
  if (!Array.isArray(bounds) || bounds.length < 4) {
    return undefined;
  }

  return {
    x: Math.round(bounds[0]),
    y: Math.round(bounds[1]),
    width: Math.round(bounds[2]),
    height: Math.round(bounds[3])
  };
}

function normalizeProtocolText(value, limit = 200) {
  return String(value || "")
    .replace(/\s+/g, " ")
    .trim()
    .slice(0, limit);
}

function buildLayoutSummary(domSnapshot) {
  const strings = Array.isArray(domSnapshot?.strings) ? domSnapshot.strings : [];
  const documents = Array.isArray(domSnapshot?.documents) ? domSnapshot.documents : [];
  const trackedElements = [];
  const frameIds = [];
  let layoutNodeCount = 0;
  let textBoxCount = 0;

  for (const documentSnapshot of documents) {
    const frameId = protocolString(strings, documentSnapshot.frameId);
    if (frameId) {
      frameIds.push(frameId);
    }

    const nodes = documentSnapshot.nodes || {};
    const nodeNames = Array.isArray(nodes.nodeName) ? nodes.nodeName : [];
    const backendNodeIds = Array.isArray(nodes.backendNodeId) ? nodes.backendNodeId : [];
    const attributes = Array.isArray(nodes.attributes) ? nodes.attributes : [];
    const clickableNodes = protocolRareBooleanSet(nodes.isClickable);
    const shadowRootTypes = protocolRareStringMap(strings, nodes.shadowRootType);
    const layoutSnapshot = documentSnapshot.layout || {};
    const layoutNodeIndices = Array.isArray(layoutSnapshot.nodeIndex) ? layoutSnapshot.nodeIndex : [];
    const layoutBounds = Array.isArray(layoutSnapshot.bounds) ? layoutSnapshot.bounds : [];
    const layoutByNodeIndex = new Map();

    layoutNodeIndices.forEach((nodeIndex, index) => {
      layoutByNodeIndex.set(nodeIndex, protocolBoundsToBox(layoutBounds[index]));
    });

    const textBoxes = documentSnapshot.textBoxes?.bounds;
    if (Array.isArray(textBoxes)) {
      textBoxCount += textBoxes.length;
    }

    layoutNodeCount += layoutNodeIndices.length;

    for (let index = 0; index < backendNodeIds.length; index += 1) {
      const attributeRecord = protocolAttributesToRecord(strings, attributes[index]);
      const elementId = attributeRecord["data-real-browser-mcp-id"];
      if (!elementId) {
        continue;
      }

      trackedElements.push({
        elementId,
        backendDOMNodeId: backendNodeIds[index],
        nodeName: protocolString(strings, nodeNames[index]).toLowerCase(),
        frameId: frameId || undefined,
        contextId: attributeRecord["data-real-browser-mcp-context-id"] || undefined,
        isClickable: clickableNodes.has(index),
        shadowRootType: shadowRootTypes.get(index),
        bounds: layoutByNodeIndex.get(index)
      });
    }
  }

  return {
    available: true,
    documentCount: documents.length,
    layoutNodeCount,
    textBoxCount,
    frameIds: [...new Set(frameIds)],
    trackedElements: trackedElements.slice(0, 300)
  };
}

function readAxValue(rawValue) {
  if (rawValue === null || rawValue === undefined) {
    return "";
  }
  if (typeof rawValue.value === "string" || typeof rawValue.value === "number" || typeof rawValue.value === "boolean") {
    return String(rawValue.value);
  }
  return "";
}

function readAxProperty(node, name) {
  const property = Array.isArray(node?.properties)
    ? node.properties.find((entry) => entry?.name === name)
    : undefined;
  return readAxValue(property?.value);
}

function buildAccessibilitySummary(axResult, trackedLayoutElements) {
  const nodes = Array.isArray(axResult?.nodes) ? axResult.nodes : [];
  const trackedByBackendNodeId = new Map();

  for (const trackedElement of trackedLayoutElements) {
    if (typeof trackedElement.backendDOMNodeId !== "number") {
      continue;
    }
    const bucket = trackedByBackendNodeId.get(trackedElement.backendDOMNodeId) || [];
    bucket.push(trackedElement.elementId);
    trackedByBackendNodeId.set(trackedElement.backendDOMNodeId, bucket);
  }

  const trackedElements = [];
  const interestingNodes = [];

  for (const node of nodes) {
    const role = normalizeProtocolText(readAxValue(node.role), 120);
    const name = normalizeProtocolText(readAxValue(node.name), 200);
    const description = normalizeProtocolText(readAxValue(node.description) || readAxProperty(node, "description"), 200);
    const value = normalizeProtocolText(readAxValue(node.value) || readAxProperty(node, "value"), 200);
    const backendDOMNodeId = typeof node.backendDOMNodeId === "number" ? node.backendDOMNodeId : undefined;
    const ignored = Boolean(node.ignored);
    const payload = {
      nodeId: String(node.nodeId),
      backendDOMNodeId,
      role,
      name,
      description: description || undefined,
      value: value || undefined,
      ignored,
      childIds: Array.isArray(node.childIds) ? node.childIds.map((entry) => String(entry)).slice(0, 24) : []
    };

    if (!ignored && (name || ["button", "link", "textbox", "dialog", "menu", "listbox", "heading", "table"].includes(role))) {
      interestingNodes.push(payload);
    }

    if (backendDOMNodeId === undefined) {
      continue;
    }

    const elementIds = trackedByBackendNodeId.get(backendDOMNodeId) || [];
    for (const elementId of elementIds) {
      trackedElements.push({
        elementId,
        backendDOMNodeId,
        role: role || undefined,
        name: name || undefined,
        description: description || undefined,
        value: value || undefined,
        ignored
      });
    }
  }

  const dedupedTrackedElements = [...new Map(
    trackedElements.map((entry) => [entry.elementId, entry])
  ).values()];

  return {
    available: true,
    nodeCount: nodes.length,
    trackedElements: dedupedTrackedElements.slice(0, 300),
    interestingNodes: interestingNodes.slice(0, 48)
  };
}

async function capturePerceptionSummaries(tabId) {
  const emptyAccessibility = {
    available: false,
    nodeCount: 0,
    trackedElements: [],
    interestingNodes: []
  };
  const emptyLayout = {
    available: false,
    documentCount: 0,
    layoutNodeCount: 0,
    textBoxCount: 0,
    frameIds: [],
    trackedElements: []
  };

  let layout = emptyLayout;
  try {
    const domSnapshot = await debuggerSendCommand(tabId, "DOMSnapshot.captureSnapshot", {
      computedStyles: ["display", "visibility", "opacity"],
      includeDOMRects: true,
      includePaintOrder: true
    });
    layout = buildLayoutSummary(domSnapshot);
  } catch (error) {
    layout = {
      ...emptyLayout,
      error: error instanceof Error ? error.message : String(error)
    };
  }

  let accessibility = emptyAccessibility;
  try {
    const axTree = await debuggerSendCommand(tabId, "Accessibility.getFullAXTree");
    accessibility = buildAccessibilitySummary(axTree, layout.trackedElements);
  } catch (error) {
    accessibility = {
      ...emptyAccessibility,
      error: error instanceof Error ? error.message : String(error)
    };
  }

  return {
    accessibility,
    layout
  };
}

function mergePerceptionIntoSnapshot(snapshot, perception) {
  const layoutByElementId = new Map(
    perception.layout.trackedElements.map((entry) => [entry.elementId, entry])
  );
  const axByElementId = new Map(
    perception.accessibility.trackedElements.map((entry) => [entry.elementId, entry])
  );

  snapshot.elements = snapshot.elements.map((element) => {
    const layout = layoutByElementId.get(element.id);
    const ax = axByElementId.get(element.id);
    return {
      ...element,
      contextId: layout?.contextId || element.contextId,
      backendNodeId: layout?.backendDOMNodeId,
      axRole: ax?.role,
      axName: ax?.name,
      axDescription: ax?.description
    };
  });

  snapshot.accessibility = perception.accessibility;
  snapshot.layout = perception.layout;
  snapshot.state.axTreeAvailable = perception.accessibility.available;
  snapshot.state.domSnapshotAvailable = perception.layout.available;

  return snapshot;
}

function findNestedElementById(elementId) {
  const selector = `[data-real-browser-mcp-id="${CSS.escape(elementId)}"]`;
  const visitedRoots = new WeakSet();

  const search = (root) => {
    if (!root || visitedRoots.has(root)) {
      return null;
    }
    visitedRoots.add(root);

    if (typeof root.querySelector === "function") {
      const directMatch = root.querySelector(selector);
      if (directMatch) {
        return directMatch;
      }
    }

    const rootDocument = root instanceof Document ? root : root.ownerDocument || document;
    const walker = rootDocument.createTreeWalker(root, NodeFilter.SHOW_ELEMENT);

    while (walker.nextNode()) {
      const element = walker.currentNode;
      if (!(element instanceof HTMLElement)) {
        continue;
      }

      if (element.shadowRoot?.mode === "open") {
        const shadowMatch = search(element.shadowRoot);
        if (shadowMatch) {
          return shadowMatch;
        }
      }

      if (element.tagName !== "IFRAME" && element.tagName !== "FRAME") {
        continue;
      }

      try {
        const childDocument = element.contentDocument;
        if (!childDocument?.documentElement) {
          continue;
        }

        const frameMatch = search(childDocument);
        if (frameMatch) {
          return frameMatch;
        }
      } catch (_error) {
      }
    }

    return null;
  };

  return search(document);
}

function getElementStyle(element) {
  return element.ownerDocument.defaultView?.getComputedStyle?.(element) || window.getComputedStyle(element);
}

function getElementAbsoluteRect(element) {
  const rect = element.getBoundingClientRect();
  let x = rect.left;
  let y = rect.top;
  let currentWindow = element.ownerDocument.defaultView;

  while (currentWindow && currentWindow !== window) {
    const frameElement = currentWindow.frameElement;
    if (!frameElement) {
      break;
    }

    const frameRect = frameElement.getBoundingClientRect();
    x += frameRect.left;
    y += frameRect.top;
    currentWindow = frameElement.ownerDocument.defaultView;
  }

  return {
    x,
    y,
    width: rect.width,
    height: rect.height
  };
}

function scrollElementIntoViewAcrossContexts(element) {
  element.scrollIntoView({ block: "center", inline: "center", behavior: "instant" });

  let currentWindow = element.ownerDocument.defaultView;
  while (currentWindow && currentWindow !== window) {
    const frameElement = currentWindow.frameElement;
    if (!frameElement) {
      break;
    }

    frameElement.scrollIntoView({ block: "center", inline: "center", behavior: "instant" });
    currentWindow = frameElement.ownerDocument.defaultView;
  }
}

function getPageState() {
  return {
    url: location.href,
    title: document.title,
    readyState: document.readyState,
    documentToken: String(performance.timeOrigin || Date.now())
  };
}

function getElementStateById(elementId) {
  const helpers = window.__REAL_BROWSER_MCP__?.helpers;
  if (!helpers) {
    throw new Error("Runtime element helpers are not initialized. Capture a fresh snapshot first.");
  }

  const element = helpers.findElementById(elementId);
  if (!element) {
    return {
      exists: false,
      elementId
    };
  }

  const rect = helpers.getElementAbsoluteRect(element);
  const style = helpers.getElementStyle(element);
  const visible =
    rect.width > 0 &&
    rect.height > 0 &&
    style.display !== "none" &&
    style.visibility !== "hidden" &&
    Number(style.opacity || "1") > 0.02;
  const type = element.getAttribute("type") || undefined;
  const explicitRole = element.getAttribute("role");
  const role =
    explicitRole ||
    (element.tagName === "A"
      ? "link"
      : element.tagName === "BUTTON"
        ? "button"
        : element.tagName === "SELECT"
          ? "combobox"
          : element.tagName === "TEXTAREA"
            ? "textbox"
            : element.tagName === "INPUT" && type === "search"
              ? "searchbox"
              : element.tagName.toLowerCase());

  return {
    exists: true,
    elementId,
    tagName: element.tagName.toLowerCase(),
    role,
    visible,
    disabled:
      Boolean(("disabled" in element && element.disabled) || element.getAttribute("aria-disabled") === "true"),
    editable:
      element.isContentEditable ||
      ["INPUT", "TEXTAREA", "SELECT"].includes(element.tagName),
    text: String(element.innerText || element.textContent || "").replace(/\s+/g, " ").trim().slice(0, 200) || undefined,
    value:
      typeof element.value === "string"
        ? String(element.value).replace(/\s+/g, " ").trim().slice(0, 200) || undefined
        : undefined
  };
}

async function waitForNetworkIdle(tabId, idleMs = 1000, timeoutMs = 10000, maxInflightRequests = 0) {
  const state = await ensureNetworkTracking(tabId);
  const startedAt = Date.now();

  while (Date.now() - startedAt < timeoutMs) {
    touchDebuggerSession(tabId);
    const lastActivityAt = Date.parse(state.lastNetworkActivityAt || state.attachedAt);
    const idleForMs = Math.max(0, Date.now() - lastActivityAt);
    const inflightRequests = state.inflightRequests.size;

    if (inflightRequests <= maxInflightRequests && idleForMs >= idleMs) {
      return {
        idle: true,
        timedOut: false,
        inflightRequests,
        idleForMs,
        elapsedMs: Date.now() - startedAt,
        lastNetworkActivityAt: state.lastNetworkActivityAt
      };
    }

    await new Promise((resolve) => setTimeout(resolve, 100));
  }

  const lastActivityAt = Date.parse(state.lastNetworkActivityAt || state.attachedAt);
  return {
    idle: false,
    timedOut: true,
    inflightRequests: state.inflightRequests.size,
    idleForMs: Math.max(0, Date.now() - lastActivityAt),
    elapsedMs: Date.now() - startedAt,
    lastNetworkActivityAt: state.lastNetworkActivityAt
  };
}

function getElementTargetById(elementId) {
  const helpers = window.__REAL_BROWSER_MCP__?.helpers;
  if (!helpers) {
    throw new Error("Runtime element helpers are not initialized. Capture a fresh snapshot first.");
  }

  const element = helpers.findElementById(elementId);
  if (!element) {
    throw new Error(`Element ${elementId} not found in page.`);
  }

  helpers.scrollElementIntoViewAcrossContexts(element);
  const rect = helpers.getElementAbsoluteRect(element);
  const centerX = rect.x + rect.width / 2;
  const centerY = rect.y + rect.height / 2;

  return {
    elementId,
    tagName: element.tagName.toLowerCase(),
    text: (element.innerText || element.value || "").trim().slice(0, 200),
    label:
      (element.getAttribute("aria-label") ||
        element.getAttribute("title") ||
        element.getAttribute("placeholder") ||
        "").trim() || undefined,
    bbox: {
      x: Math.round(rect.x),
      y: Math.round(rect.y),
      width: Math.round(rect.width),
      height: Math.round(rect.height)
    },
    center: {
      x: Math.round(centerX),
      y: Math.round(centerY)
    }
  };
}

async function cdpMouseMove(tabId, x, y) {
  await debuggerSendCommand(tabId, "Input.dispatchMouseEvent", {
    type: "mouseMoved",
    x,
    y,
    button: "none",
    buttons: 0,
    pointerType: "mouse"
  });
}

async function cdpClickAt(tabId, x, y, clickCount = 1) {
  await cdpMouseMove(tabId, x, y);
  await debuggerSendCommand(tabId, "Input.dispatchMouseEvent", {
    type: "mousePressed",
    x,
    y,
    button: "left",
    buttons: 1,
    clickCount,
    pointerType: "mouse"
  });
  await debuggerSendCommand(tabId, "Input.dispatchMouseEvent", {
    type: "mouseReleased",
    x,
    y,
    button: "left",
    buttons: 0,
    clickCount,
    pointerType: "mouse"
  });

  return {
    clicked: true,
    x,
    y,
    clickCount,
    strategy: "cdp-input-mouse"
  };
}

async function cdpHoverAt(tabId, x, y) {
  await cdpMouseMove(tabId, x, y);
  return {
    hovered: true,
    x,
    y,
    strategy: "cdp-input-mouse"
  };
}

async function cdpScrollAt(tabId, x, y, deltaX = 0, deltaY = 0) {
  await debuggerSendCommand(tabId, "Input.dispatchMouseEvent", {
    type: "mouseWheel",
    x,
    y,
    deltaX,
    deltaY,
    button: "none",
    buttons: 0,
    pointerType: "mouse"
  });
  return {
    scrolled: true,
    x,
    y,
    deltaX,
    deltaY,
    strategy: "cdp-input-wheel"
  };
}

async function cdpPressKey(tabId, key, text) {
  await debuggerSendCommand(tabId, "Input.dispatchKeyEvent", {
    type: "rawKeyDown",
    key,
    text: text || undefined
  });
  if (text) {
    await debuggerSendCommand(tabId, "Input.dispatchKeyEvent", {
      type: "char",
      key,
      text
    });
  }
  await debuggerSendCommand(tabId, "Input.dispatchKeyEvent", {
    type: "keyUp",
    key
  });

  return {
    pressed: true,
    key,
    strategy: "cdp-input-keyboard"
  };
}

async function cdpTypeText(tabId, text) {
  await debuggerSendCommand(tabId, "Input.insertText", {
    text
  });
  return {
    typed: true,
    textLength: String(text || "").length,
    strategy: "cdp-input-insert-text"
  };
}

function setEditableCaretToEnd(element) {
  if (typeof element.setSelectionRange === "function") {
    const value = typeof element.value === "string" ? element.value : "";
    const offset = value.length;
    try {
      element.setSelectionRange(offset, offset);
    } catch (_error) {
      // Some input types (for example number) do not support text selection ranges.
    }
    return;
  }

  if (!element.isContentEditable) {
    return;
  }

  const doc = element.ownerDocument;
  const selection = doc?.defaultView?.getSelection?.();
  if (!doc || !selection) {
    return;
  }

  const range = doc.createRange();
  range.selectNodeContents(element);
  range.collapse(false);
  selection.removeAllRanges();
  selection.addRange(range);
}

function clickElementById(elementId) {
  const helpers = window.__REAL_BROWSER_MCP__?.helpers;
  if (!helpers) {
    throw new Error("Runtime element helpers are not initialized. Capture a fresh snapshot first.");
  }

  const element = helpers.findElementById(elementId);
  if (!element) {
    throw new Error(`Element ${elementId} not found in page.`);
  }

  helpers.scrollElementIntoViewAcrossContexts(element);
  element.focus?.();
  element.click?.();

  return {
    clicked: true,
    elementId,
    tagName: element.tagName.toLowerCase(),
    text: (element.innerText || element.value || "").trim().slice(0, 200)
  };
}

function prepareElementForTypingById(elementId, clearFirst = true) {
  const helpers = window.__REAL_BROWSER_MCP__?.helpers;
  if (!helpers) {
    throw new Error("Runtime element helpers are not initialized. Capture a fresh snapshot first.");
  }

  const element = helpers.findElementById(elementId);
  if (!element) {
    throw new Error(`Element ${elementId} not found in page.`);
  }

  helpers.scrollElementIntoViewAcrossContexts(element);
  element.focus?.();

  if (element.isContentEditable) {
    if (clearFirst) {
      element.innerText = "";
    }
  } else if ("value" in element) {
    if (clearFirst) {
      element.value = "";
    }
  } else {
    throw new Error(`Element ${elementId} is not editable.`);
  }

  setEditableCaretToEnd(element);

  return {
    prepared: true,
    elementId,
    cleared: Boolean(clearFirst),
    value:
      "value" in element ? String(element.value).slice(0, 200) : element.innerText.slice(0, 200)
  };
}

function typeIntoElementById(elementId, text, clearFirst = true) {
  const helpers = window.__REAL_BROWSER_MCP__?.helpers;
  if (!helpers) {
    throw new Error("Runtime element helpers are not initialized. Capture a fresh snapshot first.");
  }

  const element = helpers.findElementById(elementId);
  if (!element) {
    throw new Error(`Element ${elementId} not found in page.`);
  }

  helpers.scrollElementIntoViewAcrossContexts(element);
  element.focus?.();

  if (element.isContentEditable) {
    if (clearFirst) {
      element.innerText = "";
    }
    element.innerText += text;
  } else if ("value" in element) {
    if (clearFirst) {
      element.value = "";
    }
    element.value += text;
  } else {
    throw new Error(`Element ${elementId} is not editable.`);
  }

  element.dispatchEvent(new Event("input", { bubbles: true }));
  element.dispatchEvent(new Event("change", { bubbles: true }));

  return {
    typed: true,
    elementId,
    value:
      "value" in element ? String(element.value).slice(0, 200) : element.innerText.slice(0, 200)
  };
}

function selectOptionById(elementId, valueOrLabel) {
  const helpers = window.__REAL_BROWSER_MCP__?.helpers;
  if (!helpers) {
    throw new Error("Runtime element helpers are not initialized. Capture a fresh snapshot first.");
  }

  const element = helpers.findElementById(elementId);
  if (!element) {
    throw new Error(`Element ${elementId} not found in page.`);
  }
  if (element.tagName !== "SELECT") {
    throw new Error(`Element ${elementId} is not a select element.`);
  }

  const normalizedTarget = String(valueOrLabel || "").trim().toLowerCase();
  const option = [...element.options].find((candidate) => {
    return (
      String(candidate.value || "").trim().toLowerCase() === normalizedTarget ||
      String(candidate.label || candidate.textContent || "").trim().toLowerCase() === normalizedTarget
    );
  });

  if (!option) {
    throw new Error(`Option '${valueOrLabel}' was not found for ${elementId}.`);
  }

  element.value = option.value;
  element.dispatchEvent(new Event("input", { bubbles: true }));
  element.dispatchEvent(new Event("change", { bubbles: true }));

  return {
    selected: true,
    elementId,
    value: option.value,
    label: option.label || option.textContent || ""
  };
}

function pressKeyInPage(key) {
  const active = document.activeElement || document.body;
  const eventInit = { key, bubbles: true, cancelable: true };
  active.dispatchEvent(new KeyboardEvent("keydown", eventInit));
  active.dispatchEvent(new KeyboardEvent("keypress", eventInit));
  active.dispatchEvent(new KeyboardEvent("keyup", eventInit));
  return {
    pressed: true,
    key,
    activeTagName: active.tagName?.toLowerCase?.() || "unknown"
  };
}

function scrollPageBy(deltaY = 0, deltaX = 0) {
  window.scrollBy({ top: deltaY, left: deltaX, behavior: "instant" });
  return {
    scrolled: true,
    scrollX: window.scrollX,
    scrollY: window.scrollY
  };
}

function evaluateExpression(expression) {
  const fn = new Function(`return (${expression});`);
  const value = fn();
  return {
    value
  };
}

async function captureScreenshot(tabId) {
  const tab = await chrome.tabs.get(tabId);
  if (isDebuggerUnsupportedUrl(tab.url)) {
    return captureVisibleTabFallback(tabId);
  }

  const result = await debuggerSendCommand(tabId, "Page.captureScreenshot", {
    format: "png",
    fromSurface: true,
    captureBeyondViewport: false
  });

  if (!result?.data) {
    throw new Error(`CDP screenshot returned no image payload for tab ${tabId}.`);
  }

  return {
    dataUrl: `data:image/png;base64,${result.data}`,
    mimeType: "image/png",
    strategy: "cdp-page-capture",
    backgroundSafe: true
  };
}

async function handleRequest(message) {
  const { requestId, method, params = {} } = message;
  try {
    let result;
    switch (method) {
      case "focusTab":
        result = await focusTab(params.tabId);
        break;
      case "openTab":
        result = await openTab(params.url, params.active);
        break;
      case "duplicateTab":
        result = await duplicateTab(params.tabId, params.preserveFocus);
        break;
      case "closeTab":
        result = await closeTab(params.tabId);
        break;
      case "getDebuggerState":
        result = serializeDebuggerState();
        break;
      case "getPageState":
        result = await runInTab(params.tabId, getPageState);
        break;
      case "getElementState":
        result = await runInTab(params.tabId, getElementStateById, [params.elementId]);
        break;
      case "waitForNetworkIdle":
        result = await waitForNetworkIdle(
          params.tabId,
          params.idleMs,
          params.timeoutMs,
          params.maxInflightRequests
        );
        break;
      case "navigateTab":
        result = await navigateTab(params.tabId, params.url);
        break;
      case "snapshotTab": {
        const snapshot = await runInTab(
          params.tabId,
          snapshotPage,
          [params.maxElements || 250]
        );
        const perception = await capturePerceptionSummaries(params.tabId);
        result = {
          ...mergePerceptionIntoSnapshot(snapshot, perception),
          tab: (await listTabs()).find((tab) => tab.tabId === params.tabId)
        };
        break;
      }
      case "getElementTarget":
        result = await runInTab(params.tabId, getElementTargetById, [params.elementId]);
        break;
      case "cdpClick":
        result = await cdpClickAt(params.tabId, params.x, params.y, params.clickCount);
        break;
      case "cdpTypeText":
        result = await cdpTypeText(params.tabId, params.text);
        break;
      case "cdpHover":
        result = await cdpHoverAt(params.tabId, params.x, params.y);
        break;
      case "cdpScroll":
        result = await cdpScrollAt(params.tabId, params.x, params.y, params.deltaX, params.deltaY);
        break;
      case "cdpPressKey":
        result = await cdpPressKey(params.tabId, params.key, params.text);
        break;
      case "clickElement":
        result = await runInTab(params.tabId, clickElementById, [params.elementId]);
        break;
      case "prepareElementForTyping":
        result = await runInTab(params.tabId, prepareElementForTypingById, [
          params.elementId,
          params.clearFirst
        ]);
        break;
      case "typeIntoElement":
        result = await runInTab(params.tabId, typeIntoElementById, [
          params.elementId,
          params.text,
          params.clearFirst
        ]);
        break;
      case "selectOption":
        result = await runInTab(params.tabId, selectOptionById, [
          params.elementId,
          params.valueOrLabel
        ]);
        break;
      case "pressKey":
        result = await runInTab(params.tabId, pressKeyInPage, [params.key]);
        break;
      case "scrollPage":
        result = await runInTab(params.tabId, scrollPageBy, [
          params.deltaY,
          params.deltaX
        ]);
        break;
      case "captureScreenshot":
        result = await captureScreenshot(params.tabId);
        break;
      case "evaluateScript":
        result = await runInTab(params.tabId, evaluateExpression, [params.expression]);
        break;
      default:
        throw new Error(`Unknown bridge method: ${method}`);
    }

    send({
      type: "response",
      requestId,
      ok: true,
      result
    });
  } catch (error) {
    send({
      type: "response",
      requestId,
      ok: false,
      error: error instanceof Error ? error.message : String(error)
    });
  }
}

function scheduleReconnect() {
  if (reconnectTimer) {
    clearTimeout(reconnectTimer);
  }
  reconnectTimer = setTimeout(() => {
    reconnectTimer = null;
    connect();
  }, RECONNECT_DELAY_MS);
  chrome.alarms.create(RECONNECT_ALARM_NAME, {
    when: Date.now() + RECONNECT_DELAY_MS
  });
}

function clearReconnectSchedule() {
  if (reconnectTimer) {
    clearTimeout(reconnectTimer);
    reconnectTimer = null;
  }
  try {
    chrome.alarms.clear(RECONNECT_ALARM_NAME);
  } catch (_error) {
    // Ignore alarm cleanup failures; the next reconnect tick is harmless.
  }
}

function connect() {
  if (socket && [WebSocket.OPEN, WebSocket.CONNECTING].includes(socket.readyState)) {
    return;
  }

  socket = new WebSocket(RELAY_URL);

  socket.addEventListener("open", async () => {
    clearReconnectSchedule();
    startHeartbeat();
    try {
      await sendHello();
    } catch (error) {
      console.error("Failed to send relay hello:", error);
      socket?.close();
    }
  });

  socket.addEventListener("message", async (event) => {
    try {
      const message = JSON.parse(event.data);
      if (message.type === "request") {
        await handleRequest(message);
      }
    } catch (error) {
      console.error("Failed to handle relay message:", error);
    }
  });

  socket.addEventListener("close", () => {
    stopHeartbeat();
    socket = null;
    scheduleReconnect();
  });

  socket.addEventListener("error", () => {
    stopHeartbeat();
    socket?.close();
  });
}

chrome.alarms.onAlarm.addListener((alarm) => {
  if (alarm.name === RECONNECT_ALARM_NAME) {
    connect();
  }
});

chrome.tabs.onCreated.addListener(() => {
  void broadcastTabs().catch(() => undefined);
});
chrome.tabs.onRemoved.addListener((tabId) => {
  void detachDebugger(tabId).catch(() => undefined);
  void broadcastTabs().catch(() => undefined);
});
chrome.tabs.onActivated.addListener(() => {
  void broadcastTabs().catch(() => undefined);
});
chrome.tabs.onUpdated.addListener(() => {
  void broadcastTabs().catch(() => undefined);
});
chrome.windows.onFocusChanged.addListener(() => {
  void broadcastTabs().catch(() => undefined);
});
chrome.runtime.onStartup.addListener(() => {
  connect();
});
chrome.runtime.onInstalled.addListener(() => {
  connect();
});
chrome.debugger.onEvent.addListener((source, method, params) => {
  if (typeof source.tabId !== "number") {
    return;
  }

  const state = debuggerSessions.get(source.tabId);
  if (!state) {
    return;
  }

  const now = new Date().toISOString();
  if (method === "Network.requestWillBeSent") {
    state.inflightRequests.add(String(params?.requestId || ""));
    state.lastNetworkActivityAt = now;
    return;
  }

  if (method === "Network.loadingFinished" || method === "Network.loadingFailed") {
    state.inflightRequests.delete(String(params?.requestId || ""));
    state.lastNetworkActivityAt = now;
  }
});
chrome.debugger.onDetach.addListener((source) => {
  if (typeof source.tabId === "number") {
    const state = debuggerSessions.get(source.tabId);
    if (state?.detachTimer) {
      clearTimeout(state.detachTimer);
    }
    debuggerSessions.delete(source.tabId);
  }
});

connect();
