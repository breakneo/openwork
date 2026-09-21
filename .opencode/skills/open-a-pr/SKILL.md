---
name: open-a-pr
description: Open a PR, write or rewrite a PR description, "the PR body is too long", update the PR body after evidence lands, or review whether a PR description is readable. Use whenever a PR is created or its body is edited.
---

# Skill: Open a PR

A PR body is read by a human in thirty seconds, on a phone, before the diff.
It answers four questions and nothing else. Everything a reviewer might want
later lives in the commit messages, the spec, and the evidence report; the PR
body links to them, it does not repeat them.

## The shape

`.github/pull_request_template.md` is the template. Fill every heading; add
none.

```markdown
## What is this about?
One or two sentences. Name the surface and the change in plain words.

## What problem does it solve?
The pain a person felt, or the risk we carried. Not the mechanism.

## What was the situation before?
What the person saw or could not do. Concrete, so the reviewer can
recognise it in the "before" screenshot.

## Evidence
- before → after, one line per proof, linking the report
```

Budget: the whole body under ~200 words. If you need more, you are explaining
the fix rather than the change. Move that text to the commit message.

Title: conventional commit, imperative, under 70 characters
(`fix(app): preserve background streaming across conversation returns`).

## Evidence points, it does not restate

The evidence is the spec and the report the publisher generates from it. The
report's headings and captions are the spec's title, `before:` / `after:`
step names and assertion claims (`write-a-spec` is the contract). The PR body
names the spec and says in one line what the reader will see:

```markdown
## Evidence
`evals/specs/browser-tabs-owned-by-thread.e2e.test.ts` — before: the toolbar
shows Suspend; after: it does not, and a page still opens and can be used.
Report and verdict: the test-evidence comment on this PR.
```

Rules:

- The `before:` here and "What was the situation before?" describe the same
  moment. If they disagree, fix one.
- Verdict, head SHA and screenshots live in the sticky comment and the report.
  Do not copy them into the body; they go stale when the head moves.
- If the evidence is red, say so in one sentence and why ("Evidence is red
  before it reaches the new assertions: the approval button is not found").
  Never soften it and never omit it.
- Changes with no user-visible behaviour (CI scripts, pure functions) list the
  command and its exit: `node --test .github/scripts/pr-proof.test.mjs — 6 passed`.
  One line per check. "No E2E; unit-tested" is a valid line.
- UI changes cite the DESIGN.md rule ids in one trailing line:
  `Design: P3, S4, C6`.
- If the report is hard to read, the fix is in the spec, not in the PR body.

## Leave out

These were common in past PRs and none of them helped a reviewer decide:

- Root-cause narrative, GC timers, cache internals → commit message body.
- CI status matrices, "N passed / 0 failed" for every suite → the Required
  verification check already reports this on the head.
- Pinned image digests, worktree setup, credential injection notes → the
  spec's world, or the report.
- Failures observed in other PRs → open an issue and link it in one line if
  it blocks this PR; otherwise nothing.
- Risk / Rollback / Out of scope boilerplate. If a real risk exists, it is a
  sentence under "What is this about?".
- Restating that screenshots are not proof, that flake is not certified, that
  coverage is not v2. The publisher's verdict carries those caveats.
- Qualifications of your own qualifications.

## Create or update

```bash
gh pr create --base dev --title "<type>(<scope>): <change>" --body-file /tmp/pr-body.md
gh pr edit <n> --body-file /tmp/pr-body.md     # after evidence lands or the head moves
```

Write the body to a file first and read it back as the reviewer would. If any
section makes you scroll, cut it.

The publisher posts and updates the sticky test-evidence comment on its own;
the body does not need to change when evidence lands or the head moves.

## Reviewing a body

Before reading the diff, check the body in this order and ask for a rewrite
if any fails; the fix is cheaper than a misread review:

1. Can you say in one sentence what changes for a person using the product?
2. Does "situation before" match the `before:` caption in the report?
3. Open the report from the sticky comment: do its captions tell the same
   before → after story as the body, on the current head SHA?
4. Is anything in the body that you would not need to approve? Ask for it to
   be removed, not moved into `<details>`.
