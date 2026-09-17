# Trusted primary link routing incident — 2026-09-17

## Status

Implementation and focused local verification are complete. Exact-ref Daytona verification, inspected real-Electron screenshots, evidence publication, and live pull-request gates remain pending until the signed commit is pushed.

## User-visible issue

A trusted primary click on an HTTPS link was always sent to OpenWork's built-in browser path. The desktop policy bridge returned only success or failure, so the browser panel could not distinguish a definitively unmanaged desktop from a managed one. Policy failures were reduced to a generic error without a recovery action.

An isolated clean-profile baseline confirmed that a signed-out-looking desktop opened the link in the built-in browser with no native modal. That observation did not reproduce a retained organization policy and is not evidence that every signed-out desktop is unmanaged.

## Root cause

- `apps/server/src/managed-desktop-policy.ts` already distinguished no identity plus no retained policy from retained or active organization policy, but `assert()` discarded that distinction.
- `apps/server/src/server.ts` returned only `{ allowed: true }` from `/managed-policy/evaluate`.
- `apps/desktop/electron/main.mjs` discarded safe policy error messages and exposed no authority state.
- `apps/desktop/electron/browser-panel.mjs` hard-coded trusted primary clicks to `open-builtin`.

The existing identity-generation fence remains authoritative. A policy read that races with identity installation still returns `policy_identity_changed`, and no cached allow decision is introduced.

## Repair

- Policy evaluation now returns `authority: "managed" | "unmanaged"` after the authoritative server check.
- Only an affirmative unmanaged decision routes a trusted primary HTTPS link to the OS default-browser boundary.
- Managed decisions retain built-in routing, and explicit **Open in OpenWork** behavior is unchanged.
- Retained-policy sign-out, Den outage, identity change, malformed responses, and unavailable local policy service remain fail-closed.
- Retained-policy sign-out shows **Sign in to verify your organization’s link policy** with **Sign in / Cancel**. Sign in uses the existing native settings bridge to open Cloud Account; it never asks for credentials in the dialog.
- A genuine policy denial shows **This link is blocked by your organization’s policy** with only **Cancel**.
- A service or readiness failure shows **OpenWork couldn’t reach its link-policy service** with **Retry / Cancel**. Retry performs exactly one fresh evaluation; a second failure offers only Cancel.
- Native-dialog labels follow the desktop's active application locale and fall back to English for unknown locale input. Locale input changes text only and cannot affect policy authority.
- Sender, source-frame, navigation-lifetime, and request-boundary policy checks remain in place.

## Verification so far

| Claim | Evidence | Result |
|---|---|---|
| Unmanaged/managed authority is returned by the real local endpoint | `apps/server/src/effective-permissions.e2e.test.ts` | Passed |
| Retained policy after sign-out stays fail-closed | `apps/server/src/managed-desktop-policy.test.ts` | Passed |
| Identity installation during persisted-policy read is fenced | Existing generation-race test, updated for the authority result | Passed |
| Unmanaged primary HTTPS routing, distinct sign-in/denial/outage states, localized labels, zero-launch failures, bounded Retry, managed recovery, and Cloud Account handoff | `apps/desktop/electron/browser-panel.test.mjs` (99 tests) | Passed |
| Exact trusted transcript click emits exactly `https://example.com/`, opens no built-in tab, and leaves the transcript interactive | `evals/specs/link-policy-primary-routing.e2e.test.ts`, isolated local Electron lane | Passed |
| Desktop Electron typecheck | `pnpm --filter @openwork/desktop typecheck:electron` | Passed |
| Renderer typecheck | `pnpm --filter @openwork/app typecheck` | Passed |
| Server typecheck and focused policy tests | Focused `@openwork/server` commands | Passed |
| Exact-ref Daytona product run | Requires a reviewed commit/ref because Daytona checks out a pushed ref | Pending |
| Four inspected real-Electron screenshots: sign-in, denial, outage, unmanaged external open | Must be captured from the isolated test Electron after the signed ref is available | Pending |

The first Daytona diagnostic was rejected as evidence because the uncommitted product change was not present in its `dev` checkout. It was useful only to repair a wrapped-link hit target in the spec. The corrected spec then passed against the working tree in the isolated local lane.

## Safety properties not changed

- No managed-policy bypass.
- No renderer-derived signed-out permission.
- No offline allow-cache.
- No catch-to-external fallback.
- No change to explicit link context-menu choices.
- No use of a shared desktop profile, authentication state, or protocol registration.

## Remaining proof

Create and push the signed commit, run the focused spec on Daytona against that exact ref, exercise and inspect all three managed native-dialog states plus the affirmative-unmanaged external open, publish ambient evidence, and attach the four uploaded screenshots to the pull request. Do not treat pending Warden, CodeQL, or CI checks as passed.
