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
    <div style="position: relative;">
      <input type="password" name="password" id="password" autofocus
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
  <script>
    document.getElementById("toggle-password").addEventListener("click", function () {
      var input = document.getElementById("password");
      var showing = input.type === "text";
      input.type = showing ? "password" : "text";
      this.setAttribute("aria-label", showing ? "Passwort anzeigen" : "Passwort verbergen");
      this.setAttribute("aria-pressed", String(!showing));
      document.getElementById("eye-icon").innerHTML = showing
        ? '<path d="M1 12s4-7 11-7 11 7 11 7-4 7-11 7-11-7-11-7Z"/><circle cx="12" cy="12" r="3"/>'
        : '<path d="M17.94 17.94A10.94 10.94 0 0 1 12 19c-7 0-11-7-11-7a21.6 21.6 0 0 1 5.06-5.94M9.9 4.24A10.94 10.94 0 0 1 12 4c7 0 11 7 11 7a21.6 21.6 0 0 1-2.66 3.79M14.12 14.12a3 3 0 1 1-4.24-4.24"/><line x1="1" y1="1" x2="23" y2="23"/>';
    });
  </script>
</body>
</html>`;
}
