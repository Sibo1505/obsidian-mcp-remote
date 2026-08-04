interface AuthorizeParams {
  client_id?: string;
  client_name?: string;
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

export function renderAuthorizeForm(params: AuthorizeParams, options: { errorMessage?: string; showPasskeyOption?: boolean } = {}): string {
  const { errorMessage, showPasskeyOption = false } = options;
  return `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<title>Authorize obsidian-mcp-remote</title>
<meta name="viewport" content="width=device-width, initial-scale=1">
</head>
<body style="font-family: system-ui, sans-serif; max-width: 24rem; margin: 4rem auto; padding: 0 1rem;">
  <h1 style="font-size: 1.25rem;">Vault-Zugriff autorisieren</h1>
  <p style="color: #555;">Client: <strong>${escapeHtml(params.client_name ?? params.client_id ?? "unknown")}</strong>${params.client_name ? ` <span style="color: #999;">(${escapeHtml(params.client_id ?? "unknown")})</span>` : ""}</p>
  ${errorMessage ? `<p style="color: #c00;">${escapeHtml(errorMessage)}</p>` : ""}
  <form method="post" action="/oauth/authorize" id="authorize-form">
    ${hiddenField("client_id", params.client_id)}
    ${hiddenField("redirect_uri", params.redirect_uri)}
    ${hiddenField("state", params.state)}
    ${hiddenField("code_challenge", params.code_challenge)}
    ${hiddenField("code_challenge_method", params.code_challenge_method)}
    ${hiddenField("resource", params.resource)}
    ${hiddenField("response_type", params.response_type)}
    <input type="hidden" name="webauthn_response" id="webauthn_response">
    ${
      showPasskeyOption
        ? `<button type="button" id="passkey-btn" style="width: 100%; margin-top: 1rem; padding: 0.5rem 1rem;">Mit Passkey anmelden</button>
    <p id="passkey-status" style="color: #c00; min-height: 1.2em;"></p>
    <p style="text-align: center; color: #999; margin: 0.5rem 0;">oder</p>`
        : ""
    }
    <label style="display: block; margin: 1rem 0 0.25rem;">Passwort</label>
    <div style="position: relative;">
      <input type="password" name="password" id="password" ${showPasskeyOption ? "" : "autofocus"}
        style="width: 100%; padding: 0.5rem 2.5rem 0.5rem 0.5rem; box-sizing: border-box;">
      <button type="button" id="toggle-password" aria-label="Passwort anzeigen" aria-pressed="false"
        style="position: absolute; right: 0.25rem; top: 50%; transform: translateY(-50%);
        border: none; background: none; cursor: pointer; padding: 0.25rem; line-height: 0;">
        <svg id="eye-icon" width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2">
          <path d="M1 12s4-7 11-7 11 7 11 7-4 7-11 7-11-7-11-7Z"/>
          <circle cx="12" cy="12" r="3"/>
        </svg>
      </button>
    </div>
    <button type="submit" style="margin-top: 1rem; padding: 0.5rem 1rem;">Autorisieren</button>
  </form>
  ${showPasskeyOption ? '<script src="/webauthn-browser.js"></script>' : ""}
  <script src="/authorize.js"></script>
</body>
</html>`;
}
