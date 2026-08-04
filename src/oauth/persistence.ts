import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import path from "node:path";

export interface PersistedClient {
  id: string;
  redirectUris: string[];
  grants: string[];
  clientSecret?: string;
  clientName?: string;
}

export interface PersistedToken {
  token: string;
  expiresAt?: string;
  scope?: string[];
  clientId: string;
  userId: string;
}

export interface PersistedState {
  clients: PersistedClient[];
  accessTokens: PersistedToken[];
  refreshTokens: PersistedToken[];
}

const EMPTY_STATE: PersistedState = { clients: [], accessTokens: [], refreshTokens: [] };

/** Generic read used by both the OAuth store and the WebAuthn credential store below. */
export function readJson<T>(filePath: string, fallback: T): T {
  if (!existsSync(filePath)) return fallback;
  try {
    return JSON.parse(readFileSync(filePath, "utf-8")) as T;
  } catch (error) {
    console.error(`Failed to read ${filePath}, using fallback:`, error);
    return fallback;
  }
}

/** Write-to-temp-then-rename so a crash mid-write can't corrupt the file. */
export function writeJsonAtomic<T>(filePath: string, data: T): void {
  mkdirSync(path.dirname(filePath), { recursive: true });
  const tmpPath = `${filePath}.${process.pid}.tmp`;
  writeFileSync(tmpPath, JSON.stringify(data, null, 2), "utf-8");
  renameSync(tmpPath, filePath);
}

/**
 * Survives container restarts: without this, every restart wiped the in-memory OAuth store and
 * forced every client through the full password login again. Auth codes stay in-memory only —
 * they're single-use and consumed within seconds of issuance, not worth persisting.
 */
export function loadState(filePath: string): PersistedState {
  return readJson(filePath, EMPTY_STATE);
}

export function saveState(filePath: string, state: PersistedState): void {
  writeJsonAtomic(filePath, state);
}
