import assert from "node:assert/strict";
import { test } from "node:test";
import {
  EMPTY_THREAD_TURNS,
  TURNS_FILE,
  beginPending,
  clearPending,
  configureTurnStore,
  dequeue,
  enqueue,
  loadThreadTurns,
  markStopped,
  parseTurnsFile,
  removeQueued,
  runThreadStop,
  saveThreadTurns,
  serializeTurnsFile,
  subscribeThreadStops,
  takeQueued,
  threadStop,
  threadTurns,
  withThreadTurns,
  type ThreadTurnState,
} from "./thread-queue.ts";
import { createComposerDraftStore, mergeSkillSelections, parseComposerDraft, selectionFields, type ComposerDraft, type SelectedSkill } from "./skill-selection.ts";
const draft: ComposerDraft = { text: "Keep these unsent words", skills: [{ id: "native_exact", label: "Useful skill", workspaceId: "ws_fixture", source: { type: "openwork-cloud", uri: "skill://fixture", scope: "opaque-A" }, account: { baseUrl: "https://example.invalid", orgId: "org_fixture", accountId: "user_fixture" } }] };
const selected = selectionFields(draft.skills);

test("a missing, empty, or malformed file is simply nothing unfinished", () => {
  for (const text of [null, undefined, "", "   ", "{not json", "[]", '{"threads": 4}', '{"threads": {"ses_1": {"pending": {"prompt": "no id"}, "next": [{"id": "q", "text": "  "}]}}}']) {
    assert.deepEqual(parseTurnsFile(text), { schemaVersion: 1, threads: {} }, String(text));
  }
});

test("the file round-trips, drops threads with nothing unfinished, and tolerates missing numbers", () => {
  const state: ThreadTurnState = {
    pending: { messageId: "msg_1", prompt: "Draft the note.", ...selected, startedAt: 100, stoppedAt: null },
    next: [{ id: "q_1", text: "And the summary.", ...selected, queuedAt: 110 }, { id: "q_2", text: "Then email it.", queuedAt: 120 }],
  };
  const file = withThreadTurns(withThreadTurns({ schemaVersion: 1, threads: {} }, "ses_1", state), "ses_2", EMPTY_THREAD_TURNS);
  const text = serializeTurnsFile(file);
  assert.equal(text.endsWith("\n"), true);
  const parsed = parseTurnsFile(text);
  assert.deepEqual(parseComposerDraft(JSON.stringify(draft)), draft, "selected IDs and labels survive reload/transfer");
  assert.deepEqual(parseComposerDraft(null, "Use the Useful skill"), { text: "Use the Useful skill", skills: [] }, "v1 words never infer selections");
  const next = takeQueued(threadTurns(parsed, "ses_1"), "q_1");
  assert.deepEqual(next.message?.skillSelections, draft.skills, "edit queued/send now retains the selection");
  assert.deepEqual(markStopped(threadTurns(parsed, "ses_1"), 150).pending?.skills, selected.skills);
  assert.deepEqual(parsed, { schemaVersion: 1, threads: { ses_1: state } });
  assert.deepEqual(threadTurns(parsed, "ses_2"), EMPTY_THREAD_TURNS);
  assert.deepEqual(
    parseTurnsFile('{"threads": {"ses_3": {"pending": {"messageId": "m", "prompt": "p"}, "next": [{"id": "q", "text": "later"}]}}}').threads.ses_3,
    { pending: { messageId: "m", prompt: "p", startedAt: 0, stoppedAt: null }, next: [{ id: "q", text: "later", queuedAt: 0 }] },
  );
});

test("Next keeps order, trims, refuses blanks and repeats, and drains one at a time", () => {
  let state = enqueue(EMPTY_THREAD_TURNS, { id: "q_1", text: "  First  ", queuedAt: 1 });
  state = enqueue(state, { id: "q_2", text: "Second", queuedAt: 2 });
  assert.equal(enqueue(state, { id: "q_2", text: "Second again", queuedAt: 3 }), state);
  assert.equal(enqueue(state, { id: "q_3", text: "   ", queuedAt: 3 }), state);
  assert.deepEqual(state.next.map((item) => item.text), ["First", "Second"]);

  const first = dequeue(state);
  assert.equal(first.message?.id, "q_1");
  assert.deepEqual(first.state.next.map((item) => item.id), ["q_2"]);
  const second = dequeue(first.state);
  assert.equal(second.message?.id, "q_2");
  assert.deepEqual(second.state.next, []);
  assert.deepEqual(dequeue(second.state), { state: second.state, message: null });
});

test("a queued message can be taken out to edit or send now, or removed; unknown ids change nothing", () => {
  const state = enqueue(enqueue(EMPTY_THREAD_TURNS, { id: "q_1", text: "First", queuedAt: 1 }), { id: "q_2", text: "Second", queuedAt: 2 });
  const taken = takeQueued(state, "q_2");
  assert.equal(taken.message?.text, "Second");
  assert.deepEqual(taken.state.next.map((item) => item.id), ["q_1"]);
  assert.deepEqual(takeQueued(state, "q_9"), { state, message: null });
  assert.deepEqual(removeQueued(state, "q_1").next.map((item) => item.id), ["q_2"]);
  assert.equal(removeQueued(state, "q_9"), state);
  const selectedState = enqueue(EMPTY_THREAD_TURNS, { id: "q_selected", text: "Queued words A", queuedAt: 1, ...selected });
  const onDisk = serializeTurnsFile(withThreadTurns({ schemaVersion: 1, threads: {} }, "thread", selectedState));
  const oldSkill = draft.skills[0]!;
  const conflicts: SelectedSkill[] = [
    { ...oldSkill, workspaceId: "ws_other" },
    { ...oldSkill, account: { ...oldSkill.account!, orgId: "other" } },
    { ...oldSkill, account: { ...oldSkill.account!, accountId: "other" } },
    { ...oldSkill, account: { ...oldSkill.account!, baseUrl: "https://other.invalid" } },
    { ...oldSkill, source: { ...oldSkill.source!, uri: "skill://other" } },
    { ...oldSkill, source: { ...oldSkill.source!, scope: "opaque-B" } },
    { id: oldSkill.id, label: oldSkill.label, workspaceId: oldSkill.workspaceId },
  ];
  for (const newer of conflicts) {
    const current: ComposerDraft = { text: "Unsent words B", skills: [newer] };
    const taken = takeQueued(selectedState, "q_selected");
    assert.throws(() => mergeSkillSelections(current.skills, taken.message!.skillSelections!), /conflicting/);
    assert.equal(current.text, "Unsent words B");
    assert.deepEqual(current.skills, [newer]);
    assert.deepEqual(threadTurns(parseTurnsFile(onDisk), "thread"), selectedState, "conflict leaves the original queue record durable");
    assert.throws(() => mergeSkillSelections([oldSkill], [newer]), /conflicting/, "merge order cannot discard either provenance");
  }
  assert.equal(mergeSkillSelections([oldSkill], [{ ...oldSkill, label: "Updated label" }]).length, 1, "labels are not authority");
});

test("initial draft admission is bound before Enter; late send/queue acknowledgements use per-key CAS across remounts", async () => {
  const files = new Map<string, string>();
  const store = createComposerDraftStore({ read: (key) => parseComposerDraft(files.get(key) ?? null), write: (key, value) => { files.set(key, JSON.stringify(value)); } });
  store.update("new", draft);
  const source = store.read("new");
  const transferred = store.transfer(source, "discussion");
  const initial = store.bindSubmission("discussion", "msg_original", source.value);
  let next = EMPTY_THREAD_TURNS;
  let acknowledge = () => {};
  const ack = new Promise<void>((resolve) => { acknowledge = resolve; });
  const admitted = ack.then(() => store.finishSubmission(initial, true));
  const enter = () => {
    const snapshot = store.read("discussion");
    const submission = store.beginSubmission(snapshot, "msg_duplicate");
    if (submission) next = enqueue(next, { id: submission.messageId, text: snapshot.value.text, queuedAt: 1, ...selectionFields(snapshot.value.skills) });
  };
  enter(); enter();
  assert.equal(next.next.length, 0, "delayed initial acknowledgement plus Enter cannot queue a new-ID duplicate");
  assert.equal(initial.messageId, "msg_original");
  // Another mount owns the same key and types B before A's callback runs.
  const unsubscribe = store.subscribe("discussion", () => {}); unsubscribe();
  const draftB: ComposerDraft = { text: "New words B", skills: [{ ...draft.skills[0]!, source: { ...draft.skills[0]!.source!, scope: "opaque-B" } }] };
  store.update("discussion", draftB);
  acknowledge(); await admitted;
  assert.deepEqual(store.read("discussion").value, draftB);
  assert.deepEqual(JSON.parse(files.get("discussion")!), draftB, "late A acknowledgement cannot clear persisted B");
  const queuedB = store.beginSubmission(store.read("discussion"), "queued_B"); assert.ok(queuedB);
  store.update("discussion", { text: "New words C", skills: [] });
  store.finishSubmission(queuedB, true);
  assert.equal(store.read("discussion").value.text, "New words C", "queued-save acknowledgement has the same CAS protection");
  // Returning to identical A bytes is still a newer revision (ABA).
  store.update("discussion", draft);
  assert.equal(store.clear(transferred), false);
  assert.deepEqual(store.read("discussion").value, draft);
  store.update("new", draftB);
  assert.throws(() => store.transfer(source, "another"), /changed during transfer/);
  assert.equal(store.clear(source), false);
  assert.deepEqual(store.read("new").value, draftB);
  assert.throws(() => store.transfer(store.read("new"), "discussion"), /changed during transfer/, "late transfer cannot overwrite an edited destination");
  const latest = store.beginSubmission(store.read("discussion"), "msg_latest"); assert.ok(latest);
  store.finishSubmission(latest, true);
  assert.deepEqual(store.read("discussion").value, { text: "", skills: [] }, "only the acknowledged revision clears");
});

test("the pending turn is begun, stopped, and cleared without touching Next", () => {
  const queued = enqueue(EMPTY_THREAD_TURNS, { id: "q_1", text: "Later", queuedAt: 1 });
  const begun = beginPending(queued, { messageId: "msg_1", prompt: "Now", startedAt: 5 });
  assert.deepEqual(begun.pending, { messageId: "msg_1", prompt: "Now", startedAt: 5, stoppedAt: null });
  assert.equal(begun.next, queued.next);
  const stopped = markStopped(begun, 9);
  assert.equal(stopped.pending?.stoppedAt, 9);
  assert.equal(markStopped(queued, 9), queued);
  const cleared = clearPending(stopped);
  assert.equal(cleared.pending, null);
  assert.equal(cleared.next, queued.next);
  assert.equal(clearPending(cleared), cleared);
});

test("Stop is immediately pending, single-flight across view subscriptions, and scoped on failure and retry", async () => {
  const scope = "stop-test:discussion-a";
  let calls = 0;
  let notifications = 0;
  const unsubscribe = subscribeThreadStops(() => { notifications += 1; });
  let fail: (cause: Error) => void = () => { throw new Error("Stop did not start"); };
  const response = new Promise<void>((_resolve, reject) => { fail = reject; });
  const stop = () => { calls += 1; return response; };
  const first = runThreadStop(scope, stop, "msg_a");
  assert.deepEqual(threadStop(scope), { state: "pending", messageId: "msg_a" });
  assert.equal(notifications, 1);
  unsubscribe();
  assert.equal(runThreadStop(scope, stop, "msg_a"), first);
  assert.equal(threadStop("stop-test:discussion-b"), undefined);
  fail(new Error("Cancellation could not be confirmed"));
  assert.equal(await first, false);
  assert.equal(calls, 1);
  assert.deepEqual(threadStop(scope), { state: "unconfirmed", messageId: "msg_a", error: "Cancellation could not be confirmed" });
  assert.equal(await runThreadStop(scope, async () => { calls += 1; }, "msg_a"), true);
  assert.equal(calls, 2);
  assert.equal(threadStop(scope), undefined);
});

test("the store reads one file per coworker, caches it, serializes writes, and forgets settled threads", async () => {
  const files = new Map<string, string>();
  const writes: string[] = [];
  let reads = 0;
  configureTurnStore({
    readFile: async (slug, path) => {
      reads += 1;
      const text = files.get(`${slug}/${path}`);
      if (text === undefined) throw new Error(`ENOENT: no such file ${slug}/${path}`);
      return text;
    },
    writeFile: async (slug, path, content) => {
      writes.push(`${slug}/${path}`);
      files.set(`${slug}/${path}`, content);
    },
  });
  try {
    assert.deepEqual(await loadThreadTurns("nova", "ses_1"), EMPTY_THREAD_TURNS);
    const begun = beginPending(EMPTY_THREAD_TURNS, { messageId: "msg_1", prompt: "Draft", startedAt: 1 });
    await Promise.all([
      saveThreadTurns("nova", "ses_1", begun),
      saveThreadTurns("nova", "ses_2", enqueue(EMPTY_THREAD_TURNS, { id: "q", text: "Later", ...selected, queuedAt: 2 })),
    ]);
    assert.deepEqual(writes, [`nova/${TURNS_FILE}`, `nova/${TURNS_FILE}`]);
    const onDisk = parseTurnsFile(files.get(`nova/${TURNS_FILE}`));
    assert.deepEqual(Object.keys(onDisk.threads).sort(), ["ses_1", "ses_2"]);
    assert.deepEqual(await loadThreadTurns("nova", "ses_1"), begun);
    assert.equal(reads, 1, "the file is read once per coworker");

    await saveThreadTurns("nova", "ses_1", clearPending(begun));
    assert.deepEqual(Object.keys(parseTurnsFile(files.get(`nova/${TURNS_FILE}`)).threads), ["ses_2"]);

    // Another coworker's file is its own.
    configureTurnStore({
      readFile: async (slug, path) => files.get(`${slug}/${path}`) ?? Promise.reject(new Error("ENOENT")),
      writeFile: async (slug, path, content) => { files.set(`${slug}/${path}`, content); },
    });
    assert.deepEqual(await loadThreadTurns("nova", "ses_2"), { pending: null, next: [{ id: "q", text: "Later", ...selected, queuedAt: 2 }] });
    assert.deepEqual(await loadThreadTurns("scout", "ses_2"), EMPTY_THREAD_TURNS);
  } finally {
    configureTurnStore(null);
  }
});
