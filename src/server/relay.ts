import { randomUUID } from "node:crypto";
import { WebSocketServer, type WebSocket } from "ws";
import type {
  BridgeEnvelope,
  BridgeRequest,
  BrowserInfo,
  BrowserTab,
  ConnectionStatus,
  RelayMethod,
} from "./types.js";

type PendingRequest = {
  connection: BrowserConnection;
  method: RelayMethod;
  resolve: (value: any) => void;
  reject: (reason?: unknown) => void;
  timeout: NodeJS.Timeout;
};

type BrowserConnection = {
  socket: WebSocket;
  browser?: BrowserInfo;
  tabs: Map<number, BrowserTab>;
};

export class LocalBrowserRelay {
  private readonly port: number;
  private readonly server: WebSocketServer;
  private readonly connections = new Set<BrowserConnection>();
  private readonly pending = new Map<string, PendingRequest>();

  constructor(port: number) {
    this.port = port;
    this.server = new WebSocketServer({ host: "127.0.0.1", port });
    this.server.on("connection", (socket) => this.handleConnection(socket));
  }

  getStatus(): ConnectionStatus {
    const current = this.primaryConnection();
    return {
      connected: Boolean(current?.browser),
      browser: current?.browser,
      tabs: this.listTabs(),
      relayPort: this.port,
      debugger: {
        available: Boolean(current?.browser),
        attachedTabs: [],
      },
    };
  }

  listTabs(): BrowserTab[] {
    const current = this.primaryConnection();
    if (!current) {
      return [];
    }
    return [...current.tabs.values()].sort((left, right) => {
      if (left.windowId !== right.windowId) {
        return left.windowId - right.windowId;
      }
      return left.tabId - right.tabId;
    });
  }

  async call<T = unknown>(
    method: RelayMethod,
    params: Record<string, unknown> = {},
    timeoutMs = 30_000,
  ): Promise<T> {
    const connection = this.primaryConnection();
    if (!connection) {
      throw new Error(
        "No connected browser bridge. Start the extension and let it connect to the local relay.",
      );
    }

    const requestId = randomUUID();
    const request: BridgeRequest = {
      type: "request",
      requestId,
      method,
      params,
    };

    return await new Promise<T>((resolve, reject) => {
      const timeout = setTimeout(() => {
        this.pending.delete(requestId);
        reject(
          new Error(
            `Bridge request '${method}' timed out after ${timeoutMs}ms.`,
          ),
        );
      }, timeoutMs);

      this.pending.set(requestId, {
        connection,
        method,
        resolve,
        reject,
        timeout,
      });
      connection.socket.send(JSON.stringify(request), (error) => {
        if (!error) {
          return;
        }
        clearTimeout(timeout);
        this.pending.delete(requestId);
        reject(error);
      });
    });
  }

  async close(): Promise<void> {
    for (const pending of this.pending.values()) {
      clearTimeout(pending.timeout);
      pending.reject(new Error("Relay shut down."));
    }
    this.pending.clear();

    await new Promise<void>((resolve, reject) => {
      this.server.close((error) => {
        if (error) {
          reject(error);
          return;
        }
        resolve();
      });
    });
  }

  private handleConnection(socket: WebSocket): void {
    const connection: BrowserConnection = {
      socket,
      tabs: new Map<number, BrowserTab>(),
    };
    this.connections.add(connection);

    socket.on("message", (data) => {
      this.handleMessage(connection, data.toString("utf8"));
    });

    socket.on("close", () => {
      this.connections.delete(connection);
    });

    socket.on("error", () => {
      this.connections.delete(connection);
    });
  }

  private handleMessage(connection: BrowserConnection, rawMessage: string): void {
    let envelope: BridgeEnvelope;
    try {
      envelope = JSON.parse(rawMessage) as BridgeEnvelope;
    } catch (error) {
      console.error("Failed to parse browser bridge message:", error);
      return;
    }

    if (envelope.type === "hello") {
      connection.browser = envelope.browser;
      connection.tabs = new Map(
        envelope.tabs.map((tab) => [tab.tabId, tab] satisfies [number, BrowserTab]),
      );
      return;
    }

    if (envelope.type === "tabs_updated") {
      connection.tabs = new Map(
        envelope.tabs.map((tab) => [tab.tabId, tab] satisfies [number, BrowserTab]),
      );
      return;
    }

    if (envelope.type === "pong") {
      return;
    }

    const pending = this.pending.get(envelope.requestId);
    if (!pending) {
      return;
    }

    clearTimeout(pending.timeout);
    this.pending.delete(envelope.requestId);

    if (envelope.ok) {
      this.applyMethodResult(pending.connection, pending.method, envelope.result);
      pending.resolve(envelope.result);
      return;
    }

    pending.reject(new Error(envelope.error));
  }

  private primaryConnection(): BrowserConnection | undefined {
    return [...this.connections].find((connection) => Boolean(connection.browser));
  }

  private applyMethodResult(
    connection: BrowserConnection,
    method: RelayMethod,
    result: any,
  ): void {
    if (method === "openTab" && result?.tabId) {
      connection.tabs.set(result.tabId, result as BrowserTab);
      return;
    }

    if (method === "duplicateTab" && result?.tab?.tabId) {
      connection.tabs.set(result.tab.tabId, result.tab as BrowserTab);
      return;
    }

    if (method === "closeTab" && result?.tabId) {
      connection.tabs.delete(result.tabId as number);
      return;
    }

    if (method === "navigateTab" && result?.tabId) {
      const current = connection.tabs.get(result.tabId as number);
      if (!current) {
        return;
      }

      connection.tabs.set(result.tabId as number, {
        ...current,
        url: result.url ?? current.url,
        title: result.title ?? current.title,
        status: result.status ?? current.status,
      });
      return;
    }

    if (method === "focusTab" && result?.tabId) {
      const focused = connection.tabs.get(result.tabId as number);
      if (!focused) {
        return;
      }

      for (const [tabId, tab] of connection.tabs.entries()) {
        if (tab.windowId !== focused.windowId) {
          continue;
        }

        connection.tabs.set(tabId, {
          ...tab,
          active: tabId === focused.tabId,
        });
      }
    }
  }
}
