import { loadConfig } from "./config.js";
import { startServers } from "./start.js";

const config = loadConfig();
await startServers(config, process.env);
