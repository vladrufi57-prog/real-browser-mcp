const RELAY_URL = "ws://127.0.0.1:17373";
const RECONNECT_DELAY_MS = 2000;
const DEBUGGER_PROTOCOL_VERSION = "1.3";
const DEBUGGER_IDLE_DETACH_MS = 15000;

let socket = null;
let reconnectTimer = null;
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
    detachTimer: null
  };

  debuggerSessions.set(tabId, state);
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

function serializeDebuggerState() {
  return {
    available: Boolean(chrome.debugger),
    attachedTabs: [...debuggerSessions.values()].map((entry) => ({
      tabId: entry.tabId,
      attachedAt: entry.attachedAt,
      lastUsedAt: entry.lastUsedAt
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
  const state = window[GLOBAL_KEY] || (window[GLOBAL_KEY] = { counter: 1 });
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

  const normalizeText = (value) =>
    String(value || "")
      .replace(/\s+/g, " ")
      .trim();

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

  const getText = (element, limit = 400) => {
    const text = normalizeText(element.innerText || element.textContent || element.value || "");
    return text.slice(0, limit);
  };

  const getDescribedByText = (element) => {
    const describedBy = element.getAttribute("aria-describedby");
    if (!describedBy) {
      return "";
    }

    return normalizeText(
      describedBy
        .split(/\s+/)
        .map((id) => document.getElementById(id)?.innerText || document.getElementById(id)?.textContent || "")
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
        .map((id) => normalizeText(document.getElementById(id)?.innerText || document.getElementById(id)?.textContent || ""))
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
    const rect = element.getBoundingClientRect();
    const style = window.getComputedStyle(element);
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

  const elements = [];
  for (const element of [...document.querySelectorAll(selectors)]) {
    if (elements.length >= maxElements) {
      break;
    }
    const snapshot = buildElementSnapshot(element);
    if (!snapshot) {
      continue;
    }
    elements.push(snapshot);
  }

  const headings = [...document.querySelectorAll("h1,h2,h3,h4,h5,h6")]
    .map((heading) => {
      const text = getText(heading, 250);
      if (!text) {
        return null;
      }
      ensureElementId(heading);
      return {
        elementId: ensureElementId(heading),
        level: Number(heading.tagName.slice(1)),
        text,
        bbox: toBox(heading.getBoundingClientRect())
      };
    })
    .filter(Boolean)
    .slice(0, 20);

  const forms = [...document.querySelectorAll("form")]
    .map((form) => {
      const fields = [...form.querySelectorAll("input, textarea, select, [contenteditable='true'], [contenteditable='']")]
        .map((field) => {
          ensureElementId(field);
          const options = field.tagName === "SELECT"
            ? [...field.options].map((option) => normalizeText(option.textContent || option.label || "")).filter(Boolean).slice(0, 30)
            : undefined;

          return {
            elementId: ensureElementId(field),
            role: getRole(field),
            type: field.getAttribute("type") || undefined,
            label: getLabel(field).slice(0, 200),
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
        .slice(0, 20);

      const submitButtons = [...form.querySelectorAll("button, input[type='submit'], input[type='button']")]
        .map((button) => {
          ensureElementId(button);
          return {
            elementId: ensureElementId(button),
            text: getText(button, 120),
            label: getLabel(button).slice(0, 120),
            disabled:
              Boolean(("disabled" in button && button.disabled) || button.getAttribute("aria-disabled") === "true")
          };
        })
        .slice(0, 8);

      if (!fields.length && !submitButtons.length) {
        return null;
      }

      const formName = normalizeText(
        form.getAttribute("aria-label") ||
        form.querySelector("legend")?.innerText ||
        form.querySelector("h1,h2,h3,h4,h5,h6")?.innerText ||
        ""
      ).slice(0, 200);

      ensureElementId(form);
      return {
        elementId: ensureElementId(form),
        name: formName,
        method: (form.getAttribute("method") || "get").toLowerCase(),
        action: form.getAttribute("action") || undefined,
        fields,
        submitButtons
      };
    })
    .filter(Boolean)
    .slice(0, 10);

  const images = [...document.querySelectorAll("img, canvas, video")]
    .map((element) => {
      const rect = element.getBoundingClientRect();
      const style = window.getComputedStyle(element);
      if (!isVisible(element, style, rect)) {
        return null;
      }

      ensureElementId(element);
      const kind = element.tagName.toLowerCase();
      const caption = normalizeText(
        element.closest("figure")?.querySelector("figcaption")?.innerText ||
        element.getAttribute("aria-description") ||
        ""
      ).slice(0, 200);

      return {
        elementId: ensureElementId(element),
        kind,
        alt: normalizeText(element.getAttribute("alt") || element.getAttribute("aria-label") || "").slice(0, 200),
        title: normalizeText(element.getAttribute("title") || "").slice(0, 200) || undefined,
        src: element.getAttribute("src") || undefined,
        caption: caption || undefined,
        loaded:
          kind === "img"
            ? Boolean(element.complete && element.naturalWidth > 0)
            : true,
        bbox: toBox(rect)
      };
    })
    .filter(Boolean)
    .slice(0, 20);

  const landmarks = [...document.querySelectorAll("main, nav, header, footer, aside, section, [role]")]
    .map((element) => {
      const role = getRole(element);
      if (!landmarkRoles.has(role)) {
        return null;
      }
      const textExcerpt = getText(element, 250);
      if (!textExcerpt && !getLabel(element)) {
        return null;
      }
      ensureElementId(element);
      return {
        elementId: ensureElementId(element),
        role,
        label: getLabel(element).slice(0, 200),
        textExcerpt
      };
    })
    .filter(Boolean)
    .slice(0, 20);

  const interactiveElements = elements.filter((element) => {
    if (!element.visible || element.disabled) {
      return false;
    }

    return (
      ["button", "link", "textbox", "combobox", "checkbox", "radio"].includes(element.role) ||
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

  const activeElement =
    document.activeElement instanceof HTMLElement ? document.activeElement : null;
  const activeSnapshot = activeElement ? buildElementSnapshot(activeElement) : null;
  const selectionText = normalizeText(window.getSelection?.()?.toString() || "").slice(0, 500);
  const bodyText = normalizeText(document.body?.innerText || "");
  const hasLoginForm = forms.some((form) =>
    form.fields.some((field) => field.type === "password")
  );
  const hasSearch =
    forms.some((form) =>
      form.fields.some((field) =>
        field.type === "search" || /search/i.test(`${field.label} ${field.placeholder || ""}`)
      )
    ) ||
    Boolean(document.querySelector("input[type='search'], [role='search']"));
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
      hasDialog: Boolean(document.querySelector("dialog[open], [role='dialog'], [aria-modal='true']")),
      hasLoginForm,
      hasSearch,
      hasCookieBanner,
      activeElementId: activeSnapshot?.id,
      activeElementRole: activeSnapshot?.role,
      activeElementLabel: activeSnapshot?.label || activeSnapshot?.text || undefined,
      selectionText: selectionText || undefined
    },
    documentTextExcerpt: bodyText.slice(0, 12000),
    headings,
    forms,
    images,
    landmarks,
    primaryActions,
    elements
  };
}

function getElementTargetById(elementId) {
  const element = document.querySelector(`[data-real-browser-mcp-id="${CSS.escape(elementId)}"]`);
  if (!element) {
    throw new Error(`Element ${elementId} not found in page.`);
  }

  element.scrollIntoView({ block: "center", inline: "center", behavior: "instant" });
  const rect = element.getBoundingClientRect();
  const centerX = rect.left + rect.width / 2;
  const centerY = rect.top + rect.height / 2;

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

function clickElementById(elementId) {
  const element = document.querySelector(`[data-real-browser-mcp-id="${CSS.escape(elementId)}"]`);
  if (!element) {
    throw new Error(`Element ${elementId} not found in page.`);
  }

  element.scrollIntoView({ block: "center", inline: "center", behavior: "instant" });
  element.focus?.();
  element.click?.();

  return {
    clicked: true,
    elementId,
    tagName: element.tagName.toLowerCase(),
    text: (element.innerText || element.value || "").trim().slice(0, 200)
  };
}

function typeIntoElementById(elementId, text, clearFirst = true) {
  const element = document.querySelector(`[data-real-browser-mcp-id="${CSS.escape(elementId)}"]`);
  if (!element) {
    throw new Error(`Element ${elementId} not found in page.`);
  }

  element.scrollIntoView({ block: "center", inline: "center", behavior: "instant" });
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
  const element = document.querySelector(`[data-real-browser-mcp-id="${CSS.escape(elementId)}"]`);
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
      case "navigateTab":
        result = await navigateTab(params.tabId, params.url);
        break;
      case "snapshotTab": {
        const snapshot = await runInTab(
          params.tabId,
          snapshotPage,
          [params.maxElements || 250]
        );
        result = {
          ...snapshot,
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
}

function connect() {
  if (socket && socket.readyState === WebSocket.OPEN) {
    return;
  }

  socket = new WebSocket(RELAY_URL);

  socket.addEventListener("open", async () => {
    await sendHello();
  });

  socket.addEventListener("message", async (event) => {
    const message = JSON.parse(event.data);
    if (message.type === "request") {
      await handleRequest(message);
    }
  });

  socket.addEventListener("close", () => {
    scheduleReconnect();
  });

  socket.addEventListener("error", () => {
    socket?.close();
  });
}

chrome.tabs.onCreated.addListener(() => {
  void broadcastTabs();
});
chrome.tabs.onRemoved.addListener((tabId) => {
  void detachDebugger(tabId).catch(() => undefined);
  void broadcastTabs();
});
chrome.tabs.onActivated.addListener(() => {
  void broadcastTabs();
});
chrome.tabs.onUpdated.addListener(() => {
  void broadcastTabs();
});
chrome.windows.onFocusChanged.addListener(() => {
  void broadcastTabs();
});
chrome.runtime.onStartup.addListener(() => {
  connect();
});
chrome.runtime.onInstalled.addListener(() => {
  connect();
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
