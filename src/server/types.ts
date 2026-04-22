export type BrowserInfo = {
  browserInstanceId: string;
  browserName: string;
  browserVersion: string;
  profileLabel: string;
  userAgent: string;
  connectedAt: string;
  capabilities: string[];
};

export type BrowserTab = {
  tabId: number;
  windowId: number;
  active: boolean;
  audible: boolean;
  discarded: boolean;
  favIconUrl?: string;
  incognito: boolean;
  pinned: boolean;
  status?: string;
  title: string;
  url: string;
};

export type ElementBox = {
  x: number;
  y: number;
  width: number;
  height: number;
};

export type PageElementSnapshot = {
  id: string;
  contextId: string;
  contextType: "top-document" | "iframe-document" | "shadow-root";
  role: string;
  tagName: string;
  text: string;
  label: string;
  description?: string;
  placeholder?: string;
  type?: string;
  value?: string;
  href?: string;
  src?: string;
  alt?: string;
  visible: boolean;
  disabled: boolean;
  editable: boolean;
  checked?: boolean;
  selected?: boolean;
  backendNodeId?: number;
  axRole?: string;
  axName?: string;
  axDescription?: string;
  bbox: ElementBox;
};

export type PageHeadingSnapshot = {
  elementId: string;
  level: number;
  text: string;
  bbox: ElementBox;
};

export type PageFormFieldSnapshot = {
  elementId: string;
  role: string;
  type?: string;
  label: string;
  placeholder?: string;
  value?: string;
  required: boolean;
  invalid: boolean;
  disabled: boolean;
  checked?: boolean;
  options?: string[];
};

export type PageFormSnapshot = {
  elementId: string;
  contextId: string;
  name: string;
  method: string;
  action?: string;
  fields: PageFormFieldSnapshot[];
  submitButtons: Array<{
    elementId: string;
    text: string;
    label: string;
    disabled: boolean;
  }>;
};

export type PageImageSnapshot = {
  elementId: string;
  contextId: string;
  kind: "img" | "video" | "canvas";
  alt: string;
  title?: string;
  src?: string;
  caption?: string;
  loaded: boolean;
  bbox: ElementBox;
};

export type PageLandmarkSnapshot = {
  elementId: string;
  contextId: string;
  role: string;
  label: string;
  textExcerpt: string;
};

export type PageContextSnapshot = {
  contextId: string;
  parentContextId?: string;
  kind: "top-document" | "iframe-document" | "shadow-root";
  frameElementId?: string;
  hostElementId?: string;
  url: string;
  title?: string;
  name?: string;
  sameOrigin: boolean;
  root: boolean;
};

export type PageOverlaySnapshot = {
  elementId: string;
  contextId: string;
  kind: "dialog" | "menu" | "listbox" | "tooltip" | "popover";
  label: string;
  textExcerpt: string;
  modal: boolean;
  bbox: ElementBox;
};

export type PageEditorSnapshot = {
  elementId: string;
  contextId: string;
  kind: "textbox" | "contenteditable" | "searchbox";
  label: string;
  value?: string;
  multiline: boolean;
  focused: boolean;
  bbox: ElementBox;
};

export type PageTableSnapshot = {
  elementId: string;
  contextId: string;
  role: string;
  label: string;
  caption?: string;
  columnHeaders: string[];
  rowCount: number;
  visibleRowCount: number;
  bbox: ElementBox;
};

export type PageTrackedElementAccessibility = {
  elementId: string;
  backendDOMNodeId?: number;
  role?: string;
  name?: string;
  description?: string;
  value?: string;
  ignored: boolean;
};

export type PageInterestingAxNode = {
  nodeId: string;
  backendDOMNodeId?: number;
  role: string;
  name: string;
  description?: string;
  value?: string;
  ignored: boolean;
  childIds: string[];
};

export type PageAccessibilitySummary = {
  available: boolean;
  nodeCount: number;
  trackedElements: PageTrackedElementAccessibility[];
  interestingNodes: PageInterestingAxNode[];
  error?: string;
};

export type PageTrackedElementLayout = {
  elementId: string;
  backendDOMNodeId: number;
  nodeName: string;
  frameId?: string;
  contextId?: string;
  isClickable: boolean;
  shadowRootType?: string;
  bounds?: ElementBox;
};

export type PageLayoutSummary = {
  available: boolean;
  documentCount: number;
  layoutNodeCount: number;
  textBoxCount: number;
  frameIds: string[];
  trackedElements: PageTrackedElementLayout[];
  error?: string;
};

export type PageActionCandidate = {
  elementId: string;
  kind: "click" | "type" | "select";
  text: string;
  label: string;
  reason: string;
  score: number;
};

export type PageStateSummary = {
  readyState: string;
  hasDialog: boolean;
  hasLoginForm: boolean;
  hasSearch: boolean;
  hasCookieBanner: boolean;
  hasMenu: boolean;
  hasPopover: boolean;
  hasTable: boolean;
  hasRichEditor: boolean;
  hasVirtualizedList: boolean;
  hasIframes: boolean;
  hasShadowDom: boolean;
  axTreeAvailable: boolean;
  domSnapshotAvailable: boolean;
  activeElementId?: string;
  activeElementRole?: string;
  activeElementLabel?: string;
  selectionText?: string;
};

export type PageSnapshot = {
  capturedAt: string;
  tab: BrowserTab;
  title: string;
  url: string;
  viewport: {
    width: number;
    height: number;
  };
  scroll: {
    x: number;
    y: number;
  };
  state: PageStateSummary;
  documentTextExcerpt: string;
  contexts: PageContextSnapshot[];
  headings: PageHeadingSnapshot[];
  forms: PageFormSnapshot[];
  images: PageImageSnapshot[];
  landmarks: PageLandmarkSnapshot[];
  overlays: PageOverlaySnapshot[];
  editors: PageEditorSnapshot[];
  tables: PageTableSnapshot[];
  accessibility: PageAccessibilitySummary;
  layout: PageLayoutSummary;
  primaryActions: PageActionCandidate[];
  elements: PageElementSnapshot[];
};

export type TaskSessionSummary = {
  sessionId: string;
  label: string;
  strategy: "duplicate-tab";
  sourceTabId: number;
  workerTabId: number;
  sourceTab?: BrowserTab;
  workerTab?: BrowserTab;
  createdAt: string;
  lastUsedAt: string;
  status: "ready" | "worker_closed" | "source_closed" | "closed";
};

export type DebuggerAttachment = {
  tabId: number;
  attachedAt: string;
  lastUsedAt: string;
  networkTracking?: boolean;
  inflightRequests?: number;
  lastNetworkActivityAt?: string;
};

export type DebuggerStatus = {
  available: boolean;
  attachedTabs: DebuggerAttachment[];
};

export type BridgeResponse<T = unknown> =
  | {
      type: "response";
      requestId: string;
      ok: true;
      result: T;
    }
  | {
      type: "response";
      requestId: string;
      ok: false;
      error: string;
    };

export type BridgeEnvelope =
  | {
      type: "hello";
      browser: BrowserInfo;
      tabs: BrowserTab[];
    }
  | {
      type: "tabs_updated";
      tabs: BrowserTab[];
    }
  | {
      type: "pong";
      at: string;
    }
  | BridgeResponse;

export type RelayMethod =
  | "focusTab"
  | "openTab"
  | "duplicateTab"
  | "closeTab"
  | "getDebuggerState"
  | "getPageState"
  | "getElementState"
  | "waitForNetworkIdle"
  | "navigateTab"
  | "snapshotTab"
  | "getElementTarget"
  | "cdpClick"
  | "cdpTypeText"
  | "cdpHover"
  | "cdpScroll"
  | "cdpPressKey"
  | "clickElement"
  | "prepareElementForTyping"
  | "typeIntoElement"
  | "selectOption"
  | "pressKey"
  | "scrollPage"
  | "captureScreenshot"
  | "evaluateScript";

export type BridgeRequest = {
  type: "request";
  requestId: string;
  method: RelayMethod;
  params?: Record<string, unknown>;
};

export type ConnectionStatus = {
  connected: boolean;
  browser?: BrowserInfo;
  tabs: BrowserTab[];
  relayPort: number;
  debugger: DebuggerStatus;
};
