---
name: publish-evidence
description: Read a PR's test evidence, declare its verdict, explain a red or skipped proof, or check why no evidence comment appeared. Use after CI runs a PR's specs.
---

# Skill: Publish Evidence

CI publishes. Every `evals/specs/**/*.e2e.test.ts` a PR adds or changes runs
on the PR head (`PR change proof`), and `evidence-review` posts one sticky
`<!-- test-evidence -->` comment linking the report. You never run the
publisher, set review-app tokens, or attach screenshots by hand.

Your job is to read what CI posted and say it plainly.

## The verdict

- `Passed`: every claim has an observable assertion in the completed run.
- `Failed`: an assertion disproves an expected outcome.
- `Incomplete`: a claim has no inspectable evidence. A skip is `Incomplete`,
  never `Passed`. A pending `looks()` judgment is `Incomplete`.
- Prose and screenshots never decide it. Neither does a green publisher exit.

Report the verdict as posted, on the SHA it names. Red evidence is useful
evidence; never soften or omit it.

## No comment appeared

`PR change proof / select` found no changed spec, so `proof` skipped. Either
the change has no user-visible behaviour (say "no E2E; unit-tested" in the
PR body) or you owe a spec (`write-a-spec`). Do not run a spec locally and
paste its output instead.

## The head moved

Evidence binds to a commit. After a rebase, cherry-pick, or base merge in a
stack, CI reruns on the new head and replaces the comment. Wait for it; do
not cite the old one.

## The report is hard to read

Its headings and captions are the spec's title, `before:` / `after:` step
names, and assertion claims. Fix the spec, push, let CI rerun.

## Local preview

To see the report before pushing:

```sh
pnpm evals:e2e <slug> --local
open evals/results/test-runs/<latest>/index.html
```

This is for you. It is not evidence and does not go on the PR.
