import { mkdir } from "node:fs/promises";
import { join } from "node:path";
import { randomUUID } from "node:crypto";

const ARTIFACTS_DIR = join(process.cwd(), ".artifacts", "screenshots");

export async function ensureArtifactsDir(): Promise<void> {
  await mkdir(ARTIFACTS_DIR, { recursive: true });
}

export function jsonText(value: unknown): string {
  return JSON.stringify(value, null, 2);
}

export function textResult(text: string) {
  return {
    content: [{ type: "text" as const, text }],
  };
}

export function errorResult(message: string) {
  return {
    content: [{ type: "text" as const, text: message }],
    isError: true,
  };
}

export function nextScreenshotPath(): string {
  return join(ARTIFACTS_DIR, `${new Date().toISOString().replace(/[:.]/g, "-")}-${randomUUID()}.png`);
}
