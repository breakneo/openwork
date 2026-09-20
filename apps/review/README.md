# OpenWork Review

An immutable, private review page composed from existing test records and
DocShot receipts. Publication reads completed files; it never runs tests,
captures screenshots, or calls a model. Reference images have no implied test
result. Pending judgments and coverage gaps remain visible.

## Develop and verify

```sh
pnpm --filter @openwork/review-app... install --frozen-lockfile
pnpm --dir evals install --frozen-lockfile --ignore-scripts
pnpm --filter @openwork/review-app build
OPENWORK_EVAL_REVIEW=1 pnpm evals:pr specs/evidence-review.test.ts
```

The journey boots the production app with isolated local storage and checks
composed reports, failed and incomplete evidence, images, source records, and
rejection of production deployments through HTTP. Its inputs are explicitly
synthetic fixtures; they do not claim to have tested the example behaviors shown
in the report.

For development, create a directory and set `OPENWORK_REVIEW_LOCAL_DIR` to its
absolute path in both the app and publisher environments. Run
`pnpm --filter @openwork/review-app dev` (port 3011). `uploadReview()` also accepts
local storage through this environment variable, using the same manifest-last
write behavior. Local development has no login; keep it bound to loopback.

## Deploy once to Vercel

Create a project with root directory `apps/review`, enable source files outside
that directory, and connect a **private** Vercel Blob store. Configure
`BLOB_READ_WRITE_TOKEN` for the Preview environment. Enable **Vercel Authentication**
under Deployment Protection with **Standard Protection** (or All Deployments).
Deploy with `vercel deploy --target preview`, then give the deployment a stable
alias and use that alias for `OPENWORK_REVIEW_URL`:

```sh
vercel alias set <deployment-url> openwork-review-<team>.vercel.app
```

Never use a deployment URL (`<project>-<hash>-<team>.vercel.app`) for
`OPENWORK_REVIEW_URL`: it is an immutable snapshot, so every report link would
keep opening the app version from that one deploy. Aliases on `*.vercel.app`
stay under Standard Protection; do not alias a production custom domain.

Teammates open the PR's report link using their existing Vercel account with
access to this project. There is no app password. Vercel authenticates requests
before they reach pages, original JSON, or images; private Blob URLs are never
sent to the browser. Keep Deployment Protection enabled and the review domain
out of protection exceptions. Vercel deployments outside Preview return 503,
because Standard Protection does not protect production domains.

The local journey verifies app behavior after Vercel authentication. Verify
the hosted boundary with an anonymous request to the preview: report, JSON,
and image routes must return Vercel's authentication response. An authenticated
request (or `vercel curl` for verification) must reach the app with no Basic
authorization header. See [Vercel Authentication](https://vercel.com/docs/deployment-protection/methods-to-protect-deployments/vercel-authentication).

The **Review app deploy** workflow redeploys the app whenever `apps/review`,
`packages/review`, or the lockfile changes on the default branch (or on manual
dispatch) and moves the alias named by `OPENWORK_REVIEW_URL` to the new
deployment, then checks that the alias still answers anonymous requests with
Vercel Authentication. It needs repository variables
`OPENWORK_REVIEW_VERCEL_ORG_ID` and `OPENWORK_REVIEW_VERCEL_PROJECT_ID` (from
`.vercel/project.json` after `vercel link`) and the `VERCEL_TOKEN` secret.
Report publication uploads data to the existing app; it never creates a
deployment.

Set `OPENWORK_REVIEW_URL` and `BLOB_READ_WRITE_TOKEN` in the publishing
environment. The existing command publishes a compact link when configured:

```sh
pnpm evals:e2e --publish --pr 123 --test-run <run-directory>
pnpm evals:e2e --publish --pr 123 --all --docshot <image.png.review.json>
```

Repeat `--test-run` to choose several runs deliberately, or `--all` to choose
all stored runs matching the current PR head. Every selected source, including
DocShot, must carry the same commit. Optional `--title` and repeatable `--gap`
provide context. Test and image captions supply the default structure. Each
publish replaces the compact comment with the complete selection, preserving
the comment's identity. Include all claimed runs in that selection.

`--dry-run` validates and renders the summary without uploads or GitHub calls
(except resolving the PR head if `--all --pr` is used). Legacy single-run
publication remains available when the review app is not configured.
Visual judging is explicit: `pnpm --dir evals evidence:judge -- --test-run <run>`.

## PR change proofs

A non-exempt PR must add at least one new runnable
`evals/specs/**/*.e2e.test.ts`. Modified, renamed, deleted, or pre-existing specs
do not satisfy the contract. The narrow existing docs-only and generated model
snapshot lanes are exempt and keep their own required validation.

`Build and core checks / proof-contract` validates the live changed-file list and
each new spec's Git blob. Empty, malformed, skip-only, and todo-only files fail.
Its result feeds the existing `openwork-tests-required` aggregate. This is the
blocking **proof supplied** contract; it does not claim the change is correct.

The separate non-required **PR change proof** workflow runs only the newly added
specs against the exact PR head. Each spec gets its own bounded local job and
artifact. Failed, skipped, unsupported, setup-failed, and cancelled proofs remain
honest non-passing executions; they do not fall back to packaged smoke or another
regression. Native/platform requirements not available in this first local lane
will therefore remain visible rather than being substituted.

The credentialed **Evidence review** workflow runs trusted default-branch code.
It re-reads the current PR file list, derives the same new-spec selection, and
accepts exactly one artifact per selected spec and run attempt. Every test record
must name that spec and the current PR SHA. Downloaded PR artifacts are data and
are never imported or executed. Unrelated smoke, an unexpected proof artifact,
stale evidence, and missing/duplicate records are refused.

Candidate publisher and review-app checks live in the PR-only
`Evidence review candidate checks` workflow. It has no publishing secret or
write permission, avoiding a workflow that combines manual privileged dispatch
with PR-head execution.

For automatic publication, keep repository variable `OPENWORK_REVIEW_URL`, secret
`OPENWORK_REVIEW_BLOB_TOKEN`, and the existing Vercel Preview/private Blob
configuration. No new environment variable is required. Do not require Evidence
review or PR change proof in branch protection; only the proof-supplied contract
is part of the existing required aggregate. Human approval remains in GitHub.

To replay publication without rerunning a proof (default branch only):

```sh
gh workflow run evidence-review.yml --ref dev -f run_id=<pr-change-proof-run-id>
```

The publish job summary says **published**, **skipped**, **unavailable**, or
**failed**. Only **published** confirms delivery. A compact sticky PR comment
links to the private report; no raw trace or public screenshots are used as a
fallback. Signed-in project members should verify the report commit and sources.
Anonymous report, JSON, and image requests must redirect to Vercel Authentication.

## Contract

`packages/review/src/schema.ts` is the runtime schema and TypeScript source of
truth. Sections refer to evidence by stable IDs, allowing the same evidence to
appear in several sections. Images are deduplicated by content within a report.
Original records retain diagnostics; the page loads them only when opened.
Each upload has a new immutable ID. The manifest is written only after all
assets succeed, and the publisher rechecks the PR head before updating GitHub.

Status describes selected evidence: a failed assertion or visual judgment is
Failed; skipped/unknown tests, missing assertion evidence, pending judgments,
and declared gaps are Incomplete. An image-only document is Reference. Human
approval and discussion stay in GitHub.
