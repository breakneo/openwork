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

For automatic publication, configure repository variable `OPENWORK_REVIEW_URL`
and secret `OPENWORK_REVIEW_BLOB_TOKEN`. The separate **Evidence review** workflow
consumes existing uploaded artifacts after checks finish. It runs trusted
default-branch code, ignores stale runs, and only publishes when GitHub supplies
an associated PR and matching source commit. It never runs downloaded code.
An existing review of that commit takes precedence, preserving the author's
selected evidence. Explicit publication can update that selection.
**Do not require Evidence review in branch protection.** Failures remain visible
in its optional workflow; existing test checks retain their verdicts.

## Verify publication changes on a PR

The `Evidence review` PR jobs exercise the candidate implementation without Blob
or GitHub write credentials:

- `check-publisher`: publisher contracts plus an integration test through real
  report assembly and local storage, with synthetic GitHub responses. Download
  `publisher-contracts` for individual test results.
- `check-app`: builds the production review app and runs
  `evals/specs/evidence-review.test.ts`. Download `review-app-evidence` for its
  assertion record. Its report inputs and documentation image are synthetic
  fixtures, not demonstrations of the features named in those fixtures.

These checks prove candidate behavior locally/in CI, **not** a hosted Blob upload
or Vercel sign-in. The credentialed publisher deliberately uses the default
branch, so a PR changing it cannot claim that the deployed publisher exercised
its candidate code. No new environment variables are needed.

After merge, use an open same-repository PR whose **Build and core checks** run
has completed with `packaged-desktop-smoke-*` evidence on its current head. Its
completion triggers trusted publication. Alternatively, replay that completed
run without rerunning tests (dispatch from the default branch only):

```sh
gh workflow run evidence-review.yml --ref dev -f run_id=<completed-run-id>
```

Open the resulting `Evidence review` run's `publish` job summary:

- **published**: contains the private report link; verify the report commit and
  source records and that the PR has one compact link comment, not a raw trace.
- **unchanged**: an existing selection was preserved; no new report was published.
- **skipped**: the reason is explicit (for example, stale head, closed PR, missing
  PR association, or no current-head records). No publication success is claimed.
- **unavailable / failed**: nonzero publisher exit; check configuration and source
  run before replaying. No raw evidence is posted as a fallback.

Direct PR reports describe selected evidence, independently of the separate
required-journey check. Authenticated chained Product journeys retain their
required-plan gap reporting. Neither path grants human approval or changes the
required check verdict. Push-only completion no longer starts an automatic
publication that would usually lack an open-PR association.

Verify hosted access separately: signed-in project members can open the report,
original JSON, and image links; anonymous requests to all three must receive
Vercel authentication, not evidence bytes. A green deploy alone is not this check.
Keep repository `OPENWORK_REVIEW_URL`, `OPENWORK_REVIEW_BLOB_TOKEN`, and the existing
Vercel Preview/private Blob configuration in place. Replay uses the same identity
checks and refuses foreign, stale, unsupported, or unbound runs.

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
