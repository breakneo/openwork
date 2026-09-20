import { expect } from "vitest";
import { spec, type SpecBodyContext } from "@openwork/testkit";
import { normalizeContinuityText } from "../worlds/chat-continuity.ts";
import { chatStreamContinuityLiveWeb, liveContinuityPrompt } from "../worlds/chat-stream-continuity.ts";

const liveContinuityTest = spec.world(chatStreamContinuityLiveWeb, {
  timeout: 480_000,
  needs: { placement: "local", optIn: ["OPENWORK_EVAL_LIVE_OPENAI"], env: ["OPENAI_API_KEY"] },
  resources: { surfaces: ["appWeb"], services: [] },
});

liveContinuityTest("CONT-01-live a member returns after twenty seconds away and sees the same real OpenAI answer keep streaming", async (context) => {
  await liveContinuityJourney(context, false);
});

liveContinuityTest("CONT-01-live-history a member keeps seeing live OpenAI text during an eight-second history GET delay on return", async (context) => {
  await liveContinuityJourney(context, true);
});

async function liveContinuityJourney(
  { world, user, probe, step, evidence }: SpecBodyContext<Awaited<ReturnType<typeof chatStreamContinuityLiveWeb>>>,
  delayedHistory: boolean,
) {
  const stop: { role: "button"; label: string } = { role: "button", label: "Stop" };
  const hasStop = async () => (await probe.dom('[data-workbench-pane="primary"] button[aria-label="Stop"]'))
    .elements.some((element) => element.rect.width > 0 && element.rect.height > 0);
  const surface = (id: string) => `[data-workbench-pane="primary"] [data-session-surface-id="${id}"]`;
  const record = (value: unknown): value is Record<string, unknown> => typeof value === "object" && value !== null && !Array.isArray(value);
  const samples: Array<{
    phase: string; at: number; length: number; stop: boolean; deltas: number; nativeCharacters: number;
    lastDeltaAt: number; prefixPreserved: boolean | null;
  }> = [];
  let messageId = "";
  let returnedAt = 0;
  let originalPrefix = "";
  const native = async (id: string) => {
    const result = await world.readNative(id);
    expect(result.status).toBe(200);
    if (!Array.isArray(result.body)) throw new Error("Native v1 history must be an array");
    return result.body.filter(record);
  };
  const delta = async () => {
    const state = await world.engineHttpEvents();
    const parts = Object.values(state.textDeltas).filter((part) => part.sessionId === world.session.sessionId
      && (!messageId || part.messageId === messageId));
    return { count: parts.reduce((sum, part) => sum + part.count, 0),
      characters: parts.reduce((sum, part) => sum + part.characters, 0), lastAt: Math.max(0, ...parts.map((part) => part.lastAt)) };
  };
  const rendered = async () => {
    const rows = await world.continuity.assistantText(world.session.sessionId, messageId);
    expect(rows.length).toBeLessThanOrEqual(1);
    return normalizeContinuityText(rows[0] ?? "");
  };
  const sample = async (phase: string) => {
    const [text, active, stream] = await Promise.all([rendered(), hasStop(), delta()]);
    const value = { phase, at: Date.now(), length: text.length, stop: active,
      deltas: stream.count, nativeCharacters: stream.characters, lastDeltaAt: stream.lastAt,
      prefixPreserved: originalPrefix ? text.startsWith(originalPrefix) : null };
    samples.push(value);
    return { ...value, text };
  };
  const select = async (target: { sessionId: string; title: string }) => {
    await user.click({ text: target.title });
    await probe.eventually(() => world.continuity.surfaceState("primary"), {
      within: 10_000, intervalMs: 100, label: `selected ${target.title}`, until: (state) => state.sessionId === target.sessionId,
    });
  };
  try {
    await step("a member sends once to a real OpenAI model and sees assistant text with Stop", async () => {
      const facts = await world.runtimeFacts();
      evidence.recordJsonArtifact("CONT-01-live runtime", {
        ...facts, model: world.modelId, provider: world.providerId, outputBudget: 6_500, historyGetDelayMs: delayedHistory ? 8_000 : 0,
      });
      expect(facts).toMatchObject({ hostKind: "local", mockCount: 0, electronBridge: false });
      expect(facts.browser).toContain("HeadlessChrome/");
      await user.type("composer", liveContinuityPrompt);
      await user.click("Run task");
      await user.see(stop, { timeoutMs: 60_000 });
      const started = await probe.eventually(() => world.engineHttpEvents(), {
        within: 90_000, intervalMs: 200, label: "A-specific native text deltas from OpenAI",
        until: (state) => Object.values(state.textDeltas).some((part) => part.sessionId === world.session.sessionId && part.characters > 100),
      });
      const part = Object.values(started.textDeltas).find((part) => part.sessionId === world.session.sessionId && part.characters > 100);
      if (!part || !/^[a-zA-Z0-9_-]+$/.test(part.messageId)) throw new Error("Missing scoped native assistant identity");
      messageId = part.messageId;
      const initial = await probe.eventually(() => sample("before-away"), {
        within: 10_000, intervalMs: 200, label: "one rendered assistant text row while Stop is present",
        until: (value) => value.length > 100 && value.stop,
      });
      originalPrefix = initial.text;
      expect(started.promptPosts).toEqual({ [world.session.sessionId]: 1 });
      await user.screenshot();
    });

    await step("B stays unrelated for at least twenty seconds while A-specific native text keeps arriving", async () => {
      await select(world.neighbor);
      const awayAt = Date.now();
      const before = await delta();
      await probe.eventually(async () => {
        expect((await probe.dom(`${surface(world.neighbor.sessionId)} [data-message-role]`)).elements).toHaveLength(0);
        expect((await probe.dom(surface(world.session.sessionId))).elements).toHaveLength(0);
        const current = await sample("away");
        return { ...current, elapsed: Date.now() - awayAt };
      }, { within: 25_000, intervalMs: 500, label: "real wall-clock inactive interval beyond the 15-second GC window", until: (value) => value.elapsed >= 20_500 });
      const after = await delta();
      expect(after.count).toBeGreaterThan(before.count);
      expect(Date.now() - after.lastAt).toBeLessThan(5_000);
      await user.notSee({ text: liveContinuityPrompt });
      await user.screenshot();
      evidence.recordJsonArtifact("CONT-01-live away interval", { awayAt, endedAt: Date.now(), before, after });
    });

    await step(delayedHistory
      ? "during an eight-second history GET delay, A preserves its original prefix and shows two live increases"
      : "returning to A preserves its original prefix and shows two further live increases without replay", async () => {
      await using historyFault = delayedHistory ? await world.continuity.holdHistory(world.session.sessionId) : null;
      let releasedByTimer = false;
      const historyRelease = historyFault ? new Promise<void>((resolve) => setTimeout(resolve, 8_000)).then(() => {
        releasedByTimer = true;
        return historyFault.release();
      }) : null;
      void historyRelease?.catch(() => undefined);
      returnedAt = Date.now();
      const growthSample = async (phase: string) => {
        const historyBefore = historyFault?.read(world.session.sessionId) ?? null;
        const current = await sample(phase);
        const historyAfter = historyFault?.read(world.session.sessionId) ?? null;
        return { ...current, historyBefore, historyAfter, releasedByTimer };
      };
      try {
        await select(world.session);
        await user.see(stop, { timeoutMs: 5_000 });
        let previous = await probe.eventually(() => growthSample("returned"), {
          within: delayedHistory ? 3_000 : 10_000, intervalMs: 200, label: "return preserves the original assistant prefix while streaming",
          until: (value) => value.prefixPreserved === true && value.stop,
        });
        for (let increase = 1; increase <= 2; increase++) {
          const next = await probe.eventually(() => growthSample(`growth-${increase}`), {
            within: delayedHistory ? 2_000 : 12_000, intervalMs: 500, label: `prefix-preserving live increase ${increase} correlated with A text deltas`,
            until: (value) => value.at - previous.at >= 1_000 && value.stop && value.prefixPreserved === true
              && value.text.startsWith(previous.text) && value.length > previous.length
              && value.deltas > previous.deltas && value.nativeCharacters > previous.nativeCharacters,
          });
          expect(next.stop).toBe(true);
          expect(next.text.startsWith(originalPrefix)).toBe(true);
          expect(next.text.startsWith(previous.text)).toBe(true);
          expect(next.lastDeltaAt).toBeGreaterThan(previous.at);
          if (historyFault) {
            evidence.recordJsonArtifact(`CONT-01-live outstanding history at growth ${increase}`, {
              at: next.at, historyBefore: next.historyBefore, historyAfter: next.historyAfter, releasedByTimer: next.releasedByTimer,
            });
            expect(next.historyBefore?.outstanding).toBeGreaterThan(0);
            expect(next.historyAfter?.outstanding).toBeGreaterThan(0);
            expect(next.releasedByTimer).toBe(false);
          }
          previous = next;
          await user.screenshot();
        }
        expect((await world.engineHttpEvents()).promptPosts).toEqual({ [world.session.sessionId]: 1 });
      } finally {
        if (historyFault) {
          evidence.recordJsonArtifact("CONT-01-live delayed history", { ...historyFault.read(world.session.sessionId), returnedAt, observedAt: Date.now(), releasedByTimer });
          await user.screenshot();
          await historyRelease;
        }
      }
    });

    await step("the completed rendered answer equals native text, keeps its original prefix, and leaves B empty", async () => {
      await user.see("Run task", { timeoutMs: 180_000 });
      await user.notSee(stop);
      const messages = await native(world.session.sessionId);
      const assistants = messages.filter((entry) => record(entry.info) && entry.info.role === "assistant");
      expect(assistants).toHaveLength(1);
      const assistant = assistants[0];
      const info = assistant?.info;
      if (!record(info) || !record(info.tokens) || !Array.isArray(assistant?.parts)) throw new Error("Native assistant lacks text or usage receipt");
      evidence.recordJsonArtifact("CONT-01-live native usage", info);
      expect(info).toMatchObject({ id: messageId, modelID: world.modelId, providerID: world.providerId, finish: "stop" });
      expect(info.error).toBeUndefined();
      expect(info.tokens.output).toBeGreaterThan(0);
      expect(info.tokens.output).toBeLessThanOrEqual(6_500);
      expect(messages.filter((entry) => record(entry.info) && entry.info.role === "user")).toHaveLength(1);
      const nativeText = normalizeContinuityText(assistant.parts.filter(record)
        .filter((part) => part.type === "text" && typeof part.text === "string").map((part) => part.text).join("\n"));
      expect(nativeText.startsWith(originalPrefix)).toBe(true);
      expect(nativeText.length).toBeGreaterThan(originalPrefix.length);
      const settled = await probe.eventually(rendered, {
        within: 10_000, intervalMs: 200, label: "rendered assistant equals the entire normalized native answer", until: (text) => text === nativeText,
      });
      expect(settled).toBe(nativeText);
      expect(settled.startsWith(originalPrefix)).toBe(true);
      const until = Date.now() + 2_000;
      await probe.eventually(async () => {
        expect(await rendered()).toBe(nativeText);
        expect(await hasStop()).toBe(false);
        return Date.now() >= until;
      }, { within: 4_000, intervalMs: 250, label: "complete normalized answer remains stable" });
      expect(await native(world.neighbor.sessionId)).toEqual([]);
      expect((await world.engineHttpEvents()).promptPosts).toEqual({ [world.session.sessionId]: 1 });
      await user.screenshot();
    });
  } finally {
    const state = await world.engineHttpEvents();
    evidence.recordJsonArtifact("CONT-01-live stream samples", {
      messageId, returnedAt, originalPrefix, samples, textDeltas: state.textDeltas, promptPosts: state.promptPosts,
      historyReads: state.historyReads, observerErrors: state.errors,
    });
    await user.screenshot();
    if (await hasStop()) {
      try { await user.see("Run task", { timeoutMs: 120_000 }); }
      catch { if (await hasStop()) await user.click(stop); }
    }
    evidence.recordJsonArtifact("CONT-01-live final native receipt", (await native(world.session.sessionId)).map((entry) => entry.info));
  }
}
