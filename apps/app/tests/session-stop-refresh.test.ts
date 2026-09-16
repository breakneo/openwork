import { afterAll, afterEach, expect, test } from "bun:test";
import { GlobalRegistrator } from "@happy-dom/global-registrator";
import { act, createElement, useEffect } from "react";
import { createRoot } from "react-dom/client";
import { QueryClient, QueryClientProvider, useQuery } from "@tanstack/react-query";
import type { OpenworkSessionHistory } from "../src/app/lib/openwork-server";
import { useOpeningSessionHistory, type OpeningHistoryWindow } from "../src/react-app/domains/session/surface/session-history";
import { snapshotToUIMessages } from "../src/react-app/domains/session/sync/usechat-adapter";

const ownedDom = typeof window === "undefined";
if (ownedDom) GlobalRegistrator.register({ url: "http://localhost/" });
const previousAct = Reflect.get(globalThis, "IS_REACT_ACT_ENVIRONMENT");
Reflect.set(globalThis, "IS_REACT_ACT_ENVIRONMENT", true);
const cleanups: (() => Promise<void>)[] = [];
afterEach(async () => { for (const cleanup of cleanups.splice(0)) await cleanup(); });
afterAll(async () => {
  Reflect.set(globalThis, "IS_REACT_ACT_ENVIRONMENT", previousAct);
  if (ownedDom) await GlobalRegistrator.unregister();
});

function history(text: string, running = false): OpenworkSessionHistory {
  return {
    session: { id: "ses_shared", title: text, version: "1", time: { created: 1, updated: 2 } },
    messages: [{ info: { id: "msg_assistant", sessionID: "ses_shared", role: "assistant", parentID: "msg_user", time: { created: 2 },
      modelID: "model", providerID: "fixture", mode: "build", agent: "build", path: { cwd: "/fixture", root: "/fixture" }, cost: 0,
      tokens: { input: 0, output: 0, reasoning: 0, cache: { read: 0, write: 0 } } }, parts: [{
      type: "tool", id: "prt_tool", sessionID: "ses_shared", messageID: "msg_assistant", tool: "bash", callID: "call_tool",
      state: running ? { status: "running", input: { command: "fixture" }, time: { start: 1 } }
        : { status: "completed", input: { command: "fixture" }, title: "Finished", output: text, metadata: {}, time: { start: 1, end: 2 } },
    }] }],
  };
}

async function fixture() {
  const client = new QueryClient({ defaultOptions: { queries: { retry: false, gcTime: Infinity } } });
  const key = ["react-session-snapshot", "workspace", "ses_shared"];
  const transcriptKey = ["react-session-transcript", "workspace", "ses_shared"];
  const initial = history("Initially running", true);
  client.setQueryData(key, initial);
  client.setQueryData(transcriptKey, snapshotToUIMessages(initial));
  const host = document.createElement("div");
  document.body.append(host);
  const root = createRoot(host);
  const reads: { owner: string; token: string; signal: AbortSignal; window?: OpeningHistoryWindow; resolve: (value: OpenworkSessionHistory) => void }[] = [];
  let current: ReturnType<typeof useOpeningSessionHistory> | undefined;
  function Harness({ owner, token }: { owner: string; token: string }) {
    const opening = useOpeningSessionHistory({ owner, authToken: token, sessionId: "ses_shared", snapshotQueryKey: key, transcriptQueryKey: transcriptKey,
      readSnapshot: (signal, window) => new Promise(resolve => { reads.push({ owner, token, signal, window, resolve }); }),
      readLatest: async () => initial,
    });
    current = opening;
    const snapshot = useQuery({ queryKey: key, queryFn: ({ signal }) => opening.readFullSnapshot(signal), enabled: false });
    useEffect(() => {
      if (snapshot.data) opening.seedSnapshot(snapshot.data, () => client.setQueryData(transcriptKey, snapshotToUIMessages(snapshot.data)));
    }, [snapshot.data, opening.seedSnapshot]);
    return createElement("div", null, JSON.stringify(opening.latestHistory?.messages));
  }
  let mounted = true;
  const render = async (owner = "owner-a", token = "token-a") => {
    await act(async () => root.render(createElement(QueryClientProvider, { client }, createElement(Harness, { owner, token }))));
    await act(async () => { await new Promise(resolve => setTimeout(resolve, 5)); });
  };
  const unmount = async () => { if (mounted) { mounted = false; await act(async () => root.unmount()); } };
  cleanups.push(async () => {
    await unmount();
    client.clear();
    for (const read of reads) read.resolve(history("Fixture cleanup"));
    host.remove();
  });
  await render();
  const refresh = () => {
    if (!current) throw new Error("Missing mounted history");
    return current.refreshFullSnapshot;
  };
  const start = async (operation = refresh()) => {
    const result = operation({ desktopTransport: "main" }).then(value => ({ ok: true, value }), error => ({ ok: false, error }));
    await act(async () => { await new Promise(resolve => setTimeout(resolve, 0)); });
    return { result };
  };
  const resolve = async (index: number, value: OpenworkSessionHistory) => {
    await act(async () => { reads[index].resolve(value); });
    await act(async () => { await new Promise(resolve => setTimeout(resolve, 5)); });
  };
  return { client, key, host, reads, render, refresh, start, resolve, unmount };
}

for (const replacement of ["owner", "credential", "removed"]) {
  test(`Stop completing after ${replacement} replacement cannot cancel or overwrite the new same-key refresh`, async () => {
    const view = await fixture();
    const oldRefresh = view.refresh();
    if (replacement === "removed") {
      await view.unmount();
      view.client.removeQueries({ queryKey: view.key });
      view.client.setQueryData(view.key, history("Replacement cache"));
    } else {
      await view.render(replacement === "owner" ? "owner-b" : "owner-a", "token-b");
    }
    const newRead = Promise.withResolvers<OpenworkSessionHistory>();
    let signal: AbortSignal | undefined;
    const newRefresh = view.client.fetchQuery({ queryKey: view.key, staleTime: 0, queryFn: context => { signal = context.signal; return newRead.promise; } })
      .then(() => true, () => false);
    const old = await view.start(oldRefresh);
    expect(signal?.aborted).toBe(false);
    expect(view.reads).toHaveLength(0);
    expect((await old.result).ok).toBe(false);
    await act(async () => { newRead.resolve(history("New owner result")); await newRefresh; });
    expect(view.client.getQueryData<OpenworkSessionHistory>(view.key)?.session.title).toBe("New owner result");
  });
}

for (const change of ["owner", "remove", "cancel", "unmount"]) {
  test(`delayed main Stop snapshot rejects after ${change}, even when the transport ignores cancellation`, async () => {
    const view = await fixture();
    const pending = await view.start();
    expect(view.reads).toHaveLength(1);
    expect(view.reads[0].window).toEqual({ desktopTransport: "main" });
    if (change === "owner") await view.render("owner-b", "token-b");
    if (change === "remove") view.client.removeQueries({ queryKey: view.key });
    if (change === "cancel") await view.client.cancelQueries({ queryKey: view.key });
    if (change === "unmount") await view.unmount();
    if (change !== "owner") expect(view.reads[0].signal.aborted).toBe(true);
    const replacement = history("Newer cache must survive");
    await act(async () => { view.client.setQueryData(view.key, replacement); });
    const cachedReplacement = view.client.getQueryData(view.key);
    await view.resolve(0, history("Obsolete stopped result"));
    expect((await pending.result).ok).toBe(false);
    expect(view.client.getQueryData(view.key)).toBe(cachedReplacement);
  });
}

test("Stop's main refresh reconciles a warm running tool with a terminal snapshot without any terminal event", async () => {
  const view = await fixture();
  expect(view.host.textContent).toContain("input-streaming");
  const updateCount = view.client.getQueryState(view.key)?.dataUpdateCount ?? 0;
  const pending = await view.start();
  const query = view.client.getQueryCache().find({ queryKey: view.key });
  expect(query?.state.fetchStatus).toBe("fetching");
  const terminal = history("Terminal snapshot output");
  await view.resolve(0, terminal);
  expect((await pending.result).ok).toBe(true);
  expect(view.client.getQueryState(view.key)?.dataUpdateCount).toBe(updateCount + 1);
  expect(view.host.textContent).toContain("output-available");
  expect(view.host.textContent).toContain("Terminal snapshot output");
  expect(view.host.textContent).not.toContain("input-streaming");
});
