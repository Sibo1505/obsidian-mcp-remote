import type { Server } from "node:http";
import type { AddressInfo } from "node:net";
import type { Config } from "./config.js";
import { createApp } from "./app.js";
import { loadScopedConfig } from "./scoped/config.js";
import { createScopedApp } from "./scoped/app.js";
import { unmatchedDenyEntries } from "./scoped/guard.js";

export interface Logger {
  info(line: string): void;
  error(line: string): void;
}

const consoleLogger: Logger = {
  info: (line) => console.log(line),
  error: (line) => console.error(line),
};

export interface StartedServers {
  main: Server;
  /** Only set when SCOPED_PORT is configured and the scoped settings are valid. */
  scoped?: Server;
}

function listen(server: Server): Promise<void> {
  return new Promise((resolve, reject) => {
    const onError = (error: Error) => {
      server.off("listening", onListening);
      reject(error);
    };
    const onListening = () => {
      server.off("error", onError);
      resolve();
    };
    server.once("error", onError);
    server.once("listening", onListening);
  });
}

/**
 * Starts the main listener (OAuth + TOKEN_INTERNAL, unchanged) and, when configured, the scoped
 * listener next to it. A broken scoped setup is logged and skipped: the main listener keeps running
 * and the scoped tokens get no access anywhere (fail closed, never wider access).
 */
export async function startServers(config: Config, env: NodeJS.ProcessEnv, log: Logger = consoleLogger): Promise<StartedServers> {
  const main = createApp(config).listen(config.PORT);
  await listen(main);
  log.info(`obsidian-mcp-remote listening on port ${(main.address() as AddressInfo).port}`);

  const setup = loadScopedConfig(env, config);
  if (setup.status === "disabled") {
    if (env.SCOPED_TOKENS_JSON) log.info("SCOPED_TOKENS_JSON is set but SCOPED_PORT is not: scoped listener disabled");
    return { main };
  }
  if (setup.status === "invalid") {
    log.error(`Scoped listener not started, invalid configuration: ${setup.errors.join("; ")}`);
    return { main };
  }

  const now = Date.now();
  for (const token of setup.tokens) {
    if (token.expiresAt.getTime() <= now) {
      log.error(`Scoped token "${token.name}" expired at ${token.expiresAt.toISOString()}: its requests get 401`);
    }
    // A deny entry with a typo protects nothing, silently. Say so here, in the server log only: the
    // tool descriptions and answers never name deny entries.
    const lists: [field: string, entries: string[]][] = [
      ["readDeny", token.readDeny],
      ["writeDeny", token.writeDeny.filter((entry) => !token.readDeny.includes(entry))],
    ];
    for (const [field, entries] of lists) {
      for (const entry of await unmatchedDenyEntries(config.VAULT_PATH, entries)) {
        log.error(`Scoped token "${token.name}": ${field} entry ${JSON.stringify(entry)} matches nothing in the vault (a typo?)`);
      }
    }
  }

  // Without SCOPED_HOST the listener binds to all interfaces; the network (tailnet policy, no
  // published port) then decides who reaches it.
  const scopedApp = createScopedApp(config, setup.tokens, { log: log.info });
  const scoped = setup.host === undefined ? scopedApp.listen(setup.port) : scopedApp.listen(setup.port, setup.host);
  try {
    await listen(scoped);
  } catch (error) {
    log.error(`Scoped listener not started: ${error instanceof Error ? error.message : String(error)}`);
    return { main };
  }
  const names = setup.tokens.map((token) => token.name).join(", ");
  const bound = scoped.address() as AddressInfo;
  const where = setup.host === undefined ? "all interfaces" : bound.address;
  log.info(`Scoped listener on port ${bound.port} (${where}) for tokens: ${names}`);
  return { main, scoped };
}
