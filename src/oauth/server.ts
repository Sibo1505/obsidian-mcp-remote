import ExpressOAuthServer from "@node-oauth/express-oauth-server";
import { createModel } from "./model.js";

export function createOAuthServer(): ExpressOAuthServer {
  return new ExpressOAuthServer({
    model: createModel(),
    // false (default): the wrapper formats OAuth errors itself as spec-shaped {error, error_description}
    // JSON with the correct status code — real clients (e.g. mcp-remote) parse these fields directly.
    useErrorHandler: false,
    accessTokenLifetime: 60 * 60, // 1h
    refreshTokenLifetime: 60 * 60 * 24 * 30, // 30d — avoids a manual password re-entry every hour for a personal tool
    requireClientAuthentication: {
      authorization_code: false,
      refresh_token: false,
    },
    allowEmptyState: false,
  });
}
