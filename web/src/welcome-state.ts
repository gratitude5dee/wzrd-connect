// The welcome flow's dismissed state survives in localStorage, like the
// sidebar's cookie: readable without an API and safe to read on boot. The
// `?dismissed` route param writes the same flag so a shared link can also
// keep an install out of the first-run flow.
const welcomeDismissedKey = "wzrd-connect.welcome-dismissed";

export function readWelcomeDismissed(): boolean {
  if (typeof window === "undefined") {
    return true;
  }
  try {
    return window.localStorage.getItem(welcomeDismissedKey) === "1";
  } catch {
    // Storage can be unavailable (private mode); treat as dismissed so the
    // flow never blocks navigation.
    return true;
  }
}

export function writeWelcomeDismissed(): void {
  if (typeof window === "undefined") {
    return;
  }
  try {
    window.localStorage.setItem(welcomeDismissedKey, "1");
  } catch {
    // Storage unavailable — dismissing is best-effort only.
  }
}
