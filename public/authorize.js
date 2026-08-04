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

(function () {
  var btn = document.getElementById("passkey-btn");
  if (!btn) return; // no passkey registered yet — server didn't render the button

  var statusEl = document.getElementById("passkey-status");
  if (!window.SimpleWebAuthnBrowser || !SimpleWebAuthnBrowser.browserSupportsWebAuthn()) {
    btn.disabled = true;
    return;
  }

  btn.addEventListener("click", async function () {
    btn.disabled = true;
    statusEl.style.color = "#555";
    statusEl.textContent = "Warte auf Passkey...";
    try {
      var optionsRes = await fetch("/webauthn/authenticate/options", { method: "POST" });
      if (!optionsRes.ok) throw new Error("Kein Passkey registriert");
      var options = await optionsRes.json();
      var assertion = await SimpleWebAuthnBrowser.startAuthentication({ optionsJSON: options });
      document.getElementById("webauthn_response").value = JSON.stringify(assertion);
      document.getElementById("authorize-form").submit();
    } catch (err) {
      statusEl.style.color = "#c00";
      statusEl.textContent = "Passkey fehlgeschlagen: " + err.message;
      btn.disabled = false;
    }
  });
})();
