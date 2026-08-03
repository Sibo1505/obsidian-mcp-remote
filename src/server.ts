import { loadConfig } from "./config.js";
import { createApp } from "./app.js";

const config = loadConfig();
const app = createApp(config);

app.listen(config.PORT, () => {
  console.log(`obsidian-mcp-remote listening on port ${config.PORT}`);
});
