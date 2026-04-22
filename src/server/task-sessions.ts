import { randomUUID } from "node:crypto";
import type { BrowserTab, TaskSessionSummary } from "./types.js";

type TaskSessionRecord = {
  sessionId: string;
  label: string;
  strategy: "duplicate-tab";
  sourceTabId: number;
  workerTabId: number;
  createdAt: string;
  lastUsedAt: string;
  closedAt?: string;
};

export class TaskSessionRegistry {
  private readonly sessions = new Map<string, TaskSessionRecord>();

  constructor(private readonly listTabs: () => BrowserTab[]) {}

  create(input: {
    label?: string;
    sourceTabId: number;
    workerTabId: number;
  }): TaskSessionSummary {
    const now = new Date().toISOString();
    const sessionId = randomUUID();
    const record: TaskSessionRecord = {
      sessionId,
      label: input.label?.trim() || `Task Session ${this.sessions.size + 1}`,
      strategy: "duplicate-tab",
      sourceTabId: input.sourceTabId,
      workerTabId: input.workerTabId,
      createdAt: now,
      lastUsedAt: now,
    };
    this.sessions.set(sessionId, record);
    return this.toSummary(record);
  }

  list(): TaskSessionSummary[] {
    return [...this.sessions.values()]
      .map((record) => this.toSummary(record))
      .sort((left, right) => right.createdAt.localeCompare(left.createdAt));
  }

  get(sessionId: string): TaskSessionSummary | undefined {
    const record = this.sessions.get(sessionId);
    return record ? this.toSummary(record) : undefined;
  }

  require(sessionId: string): TaskSessionSummary {
    const session = this.get(sessionId);
    if (!session) {
      throw new Error(`Task session '${sessionId}' was not found.`);
    }
    return session;
  }

  touch(sessionId: string): TaskSessionSummary {
    const record = this.sessions.get(sessionId);
    if (!record) {
      throw new Error(`Task session '${sessionId}' was not found.`);
    }
    record.lastUsedAt = new Date().toISOString();
    return this.toSummary(record);
  }

  close(sessionId: string): TaskSessionSummary {
    const record = this.sessions.get(sessionId);
    if (!record) {
      throw new Error(`Task session '${sessionId}' was not found.`);
    }
    record.closedAt = new Date().toISOString();
    this.sessions.delete(sessionId);
    return this.toSummary(record);
  }

  private toSummary(record: TaskSessionRecord): TaskSessionSummary {
    const tabs = this.listTabs();
    const sourceTab = tabs.find((tab) => tab.tabId === record.sourceTabId);
    const workerTab = tabs.find((tab) => tab.tabId === record.workerTabId);
    const status = record.closedAt
      ? "closed"
      : !workerTab
        ? "worker_closed"
        : !sourceTab
          ? "source_closed"
          : "ready";

    return {
      sessionId: record.sessionId,
      label: record.label,
      strategy: record.strategy,
      sourceTabId: record.sourceTabId,
      workerTabId: record.workerTabId,
      sourceTab,
      workerTab,
      createdAt: record.createdAt,
      lastUsedAt: record.lastUsedAt,
      status,
    };
  }
}
