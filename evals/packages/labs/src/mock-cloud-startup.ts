/** Browser-only, opt-in faults for the hosted startup journey. No fault is
 * active during the real cold-boot measurement. Reload discards pending reads. */
export function installCloudStartupFaults() {
  const originalFetch = window.fetch.bind(window);
  window.fetch = async (input, init) => {
    const mode = sessionStorage.getItem("eval.cloud-startup-fault");
    const url = new URL(input instanceof Request ? input.url : String(input), location.href);
    if (mode && url.origin === location.origin) {
      if (mode === "access" && url.pathname.endsWith("/v1/billing/web")) {
        await new Promise((resolve) => setTimeout(resolve, 15_000));
      }
      if (url.pathname.endsWith("/v1/cloud/instance") && (mode === "waking" || mode === "failed")) {
        return Response.json({ status: mode, url: null });
      }
      // Keep the real instance ready while its workspace response is delayed.
      // This tests the distinct connection phase without falsifying boot time.
      if (mode === "connecting" && url.pathname === "/workspaces") {
        await new Promise((resolve) => setTimeout(resolve, 70_000));
      }
    }
    return originalFetch(input, init);
  };
}
