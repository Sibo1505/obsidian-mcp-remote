interface AuthorizeParams {
  client_id?: string;
  redirect_uri?: string;
  state?: string;
  code_challenge?: string;
  code_challenge_method?: string;
  resource?: string;
  response_type?: string;
}

function escapeHtml(value: string): string {
  return value
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;");
}

function hiddenField(name: string, value: string | undefined): string {
  if (!value) return "";
  return `<input type="hidden" name="${name}" value="${escapeHtml(value)}">`;
}

export function renderAuthorizeForm(params: AuthorizeParams, errorMessage?: string): string {
  return `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<title>Authorize obsidian-mcp-remote</title>
<meta name="viewport" content="width=device-width, initial-scale=1">
</head>
<body style="font-family: system-ui, sans-serif; max-width: 24rem; margin: 4rem auto; padding: 0 1rem;">
  <h1 style="font-size: 1.25rem;">Vault-Zugriff autorisieren</h1>
  <p style="color: #555;">Client: <strong>${escapeHtml(params.client_id ?? "unknown")}</strong></p>
  ${errorMessage ? `<p style="color: #c00;">${escapeHtml(errorMessage)}</p>` : ""}
  <form method="post" action="/oauth/authorize">
    ${hiddenField("client_id", params.client_id)}
    ${hiddenField("redirect_uri", params.redirect_uri)}
    ${hiddenField("state", params.state)}
    ${hiddenField("code_challenge", params.code_challenge)}
    ${hiddenField("code_challenge_method", params.code_challenge_method)}
    ${hiddenField("resource", params.resource)}
    ${hiddenField("response_type", params.response_type)}
    <label style="display: block; margin: 1rem 0 0.25rem;">Passwort</label>
    <input type="password" name="password" autofocus style="width: 100%; padding: 0.5rem; box-sizing: border-box;">
    <button type="submit" style="margin-top: 1rem; padding: 0.5rem 1rem;">Autorisieren</button>
  </form>
</body>
</html>`;
}
