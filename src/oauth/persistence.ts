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

/**
 * Survives container restarts: without this, every restart wiped the in-memory OAuth store and
 * forced every client through the full password login again. Auth codes stay in-memory only —
 * they're single-use and consumed within seconds of issuance, not worth persisting.
 */
export function loadState(filePath: string): PersistedState {
  if (!existsSync(filePath)) return EMPTY_STATE;
  try {
    return JSON.parse(readFileSync(filePath, "utf-8")) as PersistedState;
  } catch (error) {
    console.error(`Failed to read OAuth store at ${filePath}, starting empty:`, error);
    return EMPTY_STATE;
  }
}

/** Write-to-temp-then-rename so a crash mid-write can't corrupt the store. */
export function saveState(filePath: string, state: PersistedState): void {
  mkdirSync(path.dirname(filePath), { recursive: true });
  const tmpPath = `${filePath}.${process.pid}.tmp`;
  writeFileSync(tmpPath, JSON.stringify(state, null, 2), "utf-8");
  renameSync(tmpPath, filePath);
}
