import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import type { AddressInfo } from "node:net";
import { createApp } from "../src/app.js";
import type { Config } from "../src/config.js";

const execFileAsync = promisify(execFile);
async function git(cwd: string, args: string[]) {
  return execFileAsync("git", args, { cwd });
}
async function configureGitIdentity(cloneDir: string, name: string, email: string) {
  await git(cloneDir, ["config", "user.name", name]);
  await git(cloneDir, ["config", "user.email", email]);
  // Production runs in a Linux container with no autocrlf conversion. Force the same behavior
  // here so tests are deterministic regardless of the host machine's Git-for-Windows defaults.
  await git(cloneDir, ["config", "core.autocrlf", "false"]);
}

/** Shared across every test file that spins up a real server — keeps the base Config in one place. */
export function makeTestConfig(vaultRoot: string, overrides: Partial<Config> = {}): Config {
  return {
    VAULT_PATH: vaultRoot,
    TOKEN_INTERNAL: "a".repeat(32),
    DOMAIN: "test.local",
    PORT: 0,
    OAUTH_PASSWORD: "correct-horse-battery-staple",
    OAUTH_CLIENT_ID: "preregistered-client",
    OAUTH_CLIENT_SECRET: "b".repeat(32),
    OAUTH_CLIENT_REDIRECT_URI: "https://claude.ai/CHANGEME",
    OAUTH_STORE_PATH: path.join(vaultRoot, "oauth-store.json"),
    WEBAUTHN_STORE_PATH: path.join(vaultRoot, "webauthn-credential.json"),
    ...overrides,
  };
}

/** Boots a real app on a random port against a fresh temp vault, tears both down afterwards. */
export async function withTestServer(
  fn: (baseUrl: string, config: Config) => Promise<void>,
  overrides: Partial<Config> = {},
) {
  const vaultRoot = await mkdtemp(path.join(tmpdir(), "test-vault-"));
  const config = makeTestConfig(vaultRoot, overrides);

  const app = createApp(config);
  const server = app.listen(0);
  await new Promise((resolve) => server.once("listening", resolve));
  const port = (server.address() as AddressInfo).port;
  const baseUrl = `http://127.0.0.1:${port}`;

  try {
    await fn(baseUrl, config);
  } finally {
    await new Promise((resolve) => server.close(resolve));
    await rm(vaultRoot, { recursive: true, force: true });
  }
}

export function base64url(input: Buffer): string {
  return input.toString("base64").replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
}

/** For tests that only need a scratch vault directory, not a running server (e.g. vault/fs.ts, tools/*). */
export async function withTempVault(fn: (vaultRoot: string) => Promise<void>) {
  const vaultRoot = await mkdtemp(path.join(tmpdir(), "vault-test-"));
  try {
    await fn(vaultRoot);
  } finally {
    await rm(vaultRoot, { recursive: true, force: true });
  }
}

/**
 * Sets up a bare "origin" repo plus two independent clones — `vaultRoot` (stands in for the
 * MCP-server's checkout) and `otherClone` (stands in for the PC/laptop pushing its own commits) —
 * so vault/git.ts can be tested against a real remote and real pull/rebase/conflict behavior
 * instead of mocked git calls.
 */
export async function withGitFixture(fn: (vaultRoot: string, otherClone: string) => Promise<void>) {
  const root = await mkdtemp(path.join(tmpdir(), "git-fixture-"));
  const bareDir = path.join(root, "origin.git");
  const seedDir = path.join(root, "seed");
  const vaultRoot = path.join(root, "vault");
  const otherClone = path.join(root, "other");
  try {
    await git(root, ["init", "--bare", "--initial-branch=main", bareDir]);

    // Cloning a totally empty bare repo leaves HEAD unborn, which breaks `git pull`/`rev-parse
    // HEAD` in the fixtures below — seed one commit first so origin/main actually exists.
    await git(root, ["clone", bareDir, seedDir]);
    await configureGitIdentity(seedDir, "Seed", "seed@test.local");
    await writeFile(path.join(seedDir, ".gitkeep"), "");
    await git(seedDir, ["add", "."]);
    await git(seedDir, ["commit", "-m", "seed"]);
    await git(seedDir, ["push", "origin", "main"]);

    await git(root, ["clone", bareDir, vaultRoot]);
    await configureGitIdentity(vaultRoot, "Vault", "vault@test.local");

    await git(root, ["clone", bareDir, otherClone]);
    await configureGitIdentity(otherClone, "Other Device", "other@test.local");

    await fn(vaultRoot, otherClone);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
}

/** Runs a git command in `cwd` — exposed for tests asserting on repo state after calling vault/git.ts. */
export async function gitIn(cwd: string, args: string[]) {
  return git(cwd, args);
}
