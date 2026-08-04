/**
 * Best-effort push notification for security-relevant events (rate limit tripped, wrong
 * password/passkey). Opt-in via NTFY_TOPIC — https://ntfy.sh needs no account, just a topic name
 * used as a URL path, so an unset topic means "notifications off", not "broken".
 * Never throws and never delays the response it's called from: a notification failing must not
 * affect auth decisions.
 */
export function notifySecurityEvent(topic: string | undefined, message: string): void {
  if (!topic) return;

  fetch(`https://ntfy.sh/${encodeURIComponent(topic)}`, {
    method: "POST",
    body: message,
    headers: { Title: "obsidian-mcp-remote security alert", Priority: "high" },
  }).catch((error) => {
    console.error("Failed to send ntfy notification:", error);
  });
}
