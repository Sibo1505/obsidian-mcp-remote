(function () {
  var statusEl = document.getElementById("status");
  var btn = document.getElementById("register-btn");

  function setStatus(text, isError) {
    statusEl.textContent = text;
    statusEl.style.color = isError ? "#c00" : "#555";
  }

  if (!window.SimpleWebAuthnBrowser || !SimpleWebAuthnBrowser.browserSupportsWebAuthn()) {
    setStatus("Dieser Browser unterstützt WebAuthn/Passkeys nicht.", true);
    btn.disabled = true;
    return;
  }

  btn.addEventListener("click", async function () {
    var password = document.getElementById("password").value;
    btn.disabled = true;
    setStatus("Starte Registrierung...");
    try {
      var optionsRes = await fetch("/webauthn/setup/options", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ password: password }),
      });
      if (!optionsRes.ok) {
        setStatus("Falsches Passwort.", true);
        btn.disabled = false;
        return;
      }
      var options = await optionsRes.json();
      var attestation = await SimpleWebAuthnBrowser.startRegistration({ optionsJSON: options });

      var verifyRes = await fetch("/webauthn/setup/verify", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(attestation),
      });
      var result = await verifyRes.json();
      if (result.verified) {
        setStatus("Passkey registriert. Du kannst dieses Fenster schließen.");
      } else {
        setStatus("Registrierung fehlgeschlagen.", true);
        btn.disabled = false;
      }
    } catch (err) {
      setStatus("Abgebrochen oder fehlgeschlagen: " + err.message, true);
      btn.disabled = false;
    }
  });
})();
