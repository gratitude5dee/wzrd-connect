// The console sidebar's expanded state survives reloads in a cookie, like
// PAP's `sidebar_state`: readable without an API and safe to read on boot.
const sidebarStateCookie = "wzrd-connect.sidebar_state";
const sidebarStateMaxAgeSeconds = 60 * 60 * 24 * 365;

export function readSidebarExpanded(): boolean {
  if (typeof document === "undefined") {
    return false;
  }
  return document.cookie.split("; ").includes(`${sidebarStateCookie}=true`);
}

export function writeSidebarExpanded(expanded: boolean): void {
  if (typeof document === "undefined") {
    return;
  }
  document.cookie = `${sidebarStateCookie}=${expanded}; path=/; max-age=${sidebarStateMaxAgeSeconds}; samesite=lax`;
}
