export function renderSetupPage(alreadyRegistered: boolean): string {
  return `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<title>Register Passkey — obsidian-mcp-remote</title>
<meta name="viewport" content="width=device-width, initial-scale=1">
</head>
<body style="font-family: system-ui, sans-serif; max-width: 24rem; margin: 4rem auto; padding: 0 1rem;">
  <h1 style="font-size: 1.25rem;">Passkey registrieren</h1>
  ${
    alreadyRegistered
      ? '<p style="color: #a60;">Es ist bereits ein Passkey registriert. Ein neuer Passkey ersetzt ihn.</p>'
      : ""
  }
  <p id="status" style="color: #555;"></p>
  <label style="display: block; margin: 1rem 0 0.25rem;">OAuth-Passwort</label>
  <input type="password" id="password" autofocus style="width: 100%; padding: 0.5rem; box-sizing: border-box;">
  <button type="button" id="register-btn" style="margin-top: 1rem; padding: 0.5rem 1rem;">Passkey registrieren</button>

  <script src="/webauthn-browser.js"></script>
  <script src="/webauthn-setup.js"></script>
</body>
</html>`;
}
