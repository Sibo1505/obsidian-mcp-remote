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
<link rel="stylesheet" href="/theme.css">
</head>
<body class="flex min-h-screen flex-col items-center justify-center px-4 py-12">
  <div class="flex w-full max-w-sm flex-col items-center">
    <div class="mb-7 flex h-[72px] w-[72px] items-center justify-center rounded-[20px] border border-line"
      style="background: linear-gradient(145deg, rgba(44,44,46,0.9) 0%, rgba(28,28,30,0.95) 100%); box-shadow: 0 8px 32px rgba(0,0,0,0.5), 0 2px 8px rgba(0,0,0,0.3), inset 0 1px 0 rgba(255,255,255,0.08);">
      <svg width="36" height="36" viewBox="0 0 36 36" fill="none">
        <path d="M18 4L30 12V24L18 32L6 24V12L18 4Z" fill="#0A84FF18" stroke="#0A84FF60" stroke-width="1"/>
        <path d="M18 4L30 12L18 20L6 12L18 4Z" fill="#0A84FF28"/>
        <path d="M18 20V32L6 24V12L18 20Z" fill="#0A84FF10"/>
        <circle cx="18" cy="16" r="4" fill="#0A84FF" fill-opacity="0.9"/>
      </svg>
    </div>
    <div class="mb-8 text-center">
      <h1 class="mb-2 text-[28px] font-bold leading-[1.15] tracking-[-0.022em]">Vault-Zugriff autorisieren</h1>
      <p class="text-[15px] leading-normal text-ink-muted">Client: <strong class="text-ink">${escapeHtml(params.client_name ?? params.client_id ?? "unknown")}</strong>${params.client_name ? ` <span class="text-ink-faint">(${escapeHtml(params.client_id ?? "unknown")})</span>` : ""}</p>
    </div>
    <div class="glass-card w-full border border-line p-6 pt-7">
      ${
        errorMessage
          ? `<div class="mb-5 flex items-start gap-2.5 rounded-chip border border-line-danger bg-surface-danger px-3.5 py-3 text-[13px] leading-snug text-danger">
        ${escapeHtml(errorMessage)}
      </div>`
          : ""
      }
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
            ? `<button type="button" id="passkey-btn" class="btn-secondary mb-2.5">
          <svg width="16" height="16" viewBox="0 0 16 16" fill="none">
            <circle cx="6" cy="6.5" r="3.75" stroke="currentColor" stroke-width="1.4"/>
            <path d="M9 9.5l4.5 4.5" stroke="currentColor" stroke-width="1.4" stroke-linecap="round"/>
            <path d="M11.5 11.5l1.5-1.5" stroke="currentColor" stroke-width="1.4" stroke-linecap="round"/>
          </svg>
          Mit Passkey anmelden
        </button>
        <p id="passkey-status" class="mb-1 min-h-[1.2em] text-[13px] leading-snug text-ink-muted"></p>
        <div class="my-3.5 flex items-center gap-3">
          <div class="h-px flex-1 bg-line"></div>
          <span class="text-xs text-ink-faint">oder</span>
          <div class="h-px flex-1 bg-line"></div>
        </div>`
            : ""
        }
        <label class="mb-2 block text-[13px] font-medium text-ink-muted">Passwort</label>
        <div class="relative">
          <input type="password" name="password" id="password" ${showPasskeyOption ? "" : "autofocus"}
            placeholder="Passwort eingeben" class="input-field pr-11">
          <button type="button" id="toggle-password" aria-label="Passwort anzeigen" aria-pressed="false"
            class="absolute right-3 top-1/2 -translate-y-1/2 rounded p-1 text-ink-faint transition-colors hover:text-ink-muted">
            <svg id="eye-icon" width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2">
              <path d="M1 12s4-7 11-7 11 7 11 7-4 7-11 7-11-7-11-7Z"/>
              <circle cx="12" cy="12" r="3"/>
            </svg>
          </button>
        </div>
        <button type="submit" class="btn-primary mt-4">Autorisieren</button>
      </form>
    </div>
  </div>

  ${showPasskeyOption ? '<script src="/webauthn-browser.js"></script>' : ""}
  <script src="/authorize.js"></script>
</body>
</html>`;
}
