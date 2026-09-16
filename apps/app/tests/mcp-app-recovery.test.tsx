/** @jsxImportSource react */
import { afterAll, expect, test } from "bun:test";
import { GlobalRegistrator } from "@happy-dom/global-registrator";
import { act } from "react";
import { createRoot } from "react-dom/client";
import { OpenworkServerError } from "../src/app/lib/openwork-server";
import { mcpAppResolutionRetryDelayMs } from "../src/app/lib/mcp-app-resolution";

GlobalRegistrator.register({ url: "http://localhost/" });
const previousAct = Reflect.get(globalThis, "IS_REACT_ACT_ENVIRONMENT");
Reflect.set(globalThis, "IS_REACT_ACT_ENVIRONMENT", true);
afterAll(() => {
  Reflect.set(globalThis, "IS_REACT_ACT_ENVIRONMENT", previousAct);
  GlobalRegistrator.unregister();
});
const { McpAppDiagnosticNotice, isActionableMcpAppResolutionError } = await import("../src/components/chat/mcp-app-frame");

test.each(["mcp_auth_required", "mcp_permission_denied", "mcp_initialization_failed", "mcp_resource_unavailable", "tool_denied"])("%s is actionable without automatic retries", (code) => {
  const error = new OpenworkServerError(422, code, "fixture");
  expect(isActionableMcpAppResolutionError(error)).toBe(true);
  expect(mcpAppResolutionRetryDelayMs(error, 0)).toBeNull();
});

test("transport retries have a finite discovery-only budget", () => {
  const error = new OpenworkServerError(502, "mcp_unreachable", "timeout");
  expect([0, 1, 2, 3].map(attempt => mcpAppResolutionRetryDelayMs(error, attempt))).toEqual([1000, 3000, null, null]);
});

test.each(["mcp_auth_required", "mcp_permission_denied", "mcp_unreachable"])("%s keeps diagnostics collapsed and does not invent identifiers", async (causeCode) => {
  const container = document.createElement("div");
  const root = createRoot(container);
  try {
    await act(async () => root.render(<McpAppDiagnosticNotice notice="Interactive view unavailable." error={{ code: "MCP_APP_RESOLVE_FAILED", causeCode, stage: "resource-resolution", message: "diagnostic-only-message", toolName: "fixture_render", elapsedMs: 10, checkpoints: [] }} />));
    const details = container.querySelector("details");
    expect(details?.open).toBe(false);
    expect(details?.querySelector("summary")?.textContent).toBe("Technical details");
    expect(details?.textContent).toContain("diagnostic-only-message");
    expect(container.querySelector("p")?.textContent).not.toContain("diagnostic-only-message");
    expect(container.textContent).not.toContain("Copy diagnostic identifier");
    if (causeCode === "mcp_unreachable") {
      expect(container.textContent).not.toContain("sign-in");
      expect(container.textContent).not.toContain("Reconnect");
    }
  } finally {
    await act(async () => root.unmount());
  }
});
