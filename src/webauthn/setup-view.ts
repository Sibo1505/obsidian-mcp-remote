export function renderSetupPage(alreadyRegistered: boolean): string {
  return `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<title>Register Passkey — obsidian-mcp-remote</title>
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
    <h1 class="mb-8 text-center text-[28px] font-bold leading-[1.15] tracking-[-0.022em]">Passkey registrieren</h1>
    <div class="glass-card w-full border border-line p-6 pt-7">
      ${
        alreadyRegistered
          ? `<div class="mb-5 flex items-start gap-2.5 rounded-chip border border-line-warning bg-surface-warning px-3.5 py-3 text-[13px] leading-snug text-warning">
        Es ist bereits ein Passkey registriert. Ein neuer Passkey ersetzt ihn.
      </div>`
          : ""
      }
      <p id="status" class="mb-4 min-h-[1.2em] text-[13px] leading-snug text-ink-muted"></p>
      <label class="mb-2 block text-[13px] font-medium text-ink-muted">OAuth-Passwort</label>
      <input type="password" id="password" autofocus placeholder="Passwort eingeben" class="input-field mb-4">
      <button type="button" id="register-btn" class="btn-primary">
        <svg width="16" height="16" viewBox="0 0 16 16" fill="none">
          <circle cx="6" cy="6.5" r="3.75" stroke="white" stroke-width="1.4"/>
          <path d="M9 9.5l4.5 4.5" stroke="white" stroke-width="1.4" stroke-linecap="round"/>
          <path d="M11.5 11.5l1.5-1.5" stroke="white" stroke-width="1.4" stroke-linecap="round"/>
        </svg>
        Passkey registrieren
      </button>
    </div>
  </div>

  <script src="/webauthn-browser.js"></script>
  <script src="/webauthn-setup.js"></script>
</body>
</html>`;
}
