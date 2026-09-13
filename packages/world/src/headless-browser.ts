export function headlessBrowserEnvironment(input: {
  browserOrigin?: string;
  openworkUrl: string;
}): Record<string, string> {
  if (input.browserOrigin === undefined) return {};
  let origin: URL;
  try { origin = new URL(input.browserOrigin); } catch { throw new Error("Invalid headless browser origin."); }
  if (origin.protocol !== "https:" || origin.origin !== input.browserOrigin || origin.username || origin.password) {
    throw new Error("Headless browser origin must be an HTTPS origin without credentials, path, query, or fragment.");
  }
  const target = new URL(input.openworkUrl);
  if (target.protocol !== "http:" || target.hostname !== "127.0.0.1" || !target.port) {
    throw new Error("Headless browser proxy must target the loopback runtime.");
  }
  return {
    OPENWORK_DEV_BROWSER_ORIGIN: origin.origin,
    OPENWORK_DEV_OPENWORK_PROXY_TARGET: target.origin,
    VITE_OPENWORK_URL: `${origin.origin}/api/openwork`,
    VITE_OPENWORK_PORT: "443",
  };
}
