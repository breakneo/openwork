# ENG-105 demo options

This is the coordinator's option register. **At most six alternatives across the whole demo; four slots are currently listed, not four completed implementations.** Do not infer completion from an expected observation or a proposed command. Testkit assertions decide Passed; a recording alone does not.

| Option | Scope | Current state | What remains |
|---|---|---|---|
| A — managed dashboard + automatic per-member OAuth | Primary end-to-end ENG-105 scenario | Incomplete | Hosted calendar authorization server, world integration, coded proof, independent review |
| B — same scenario, dashboard created/shared via API | Portable setup requested in deliverable H | Incomplete | Public dashboard APIs discovered; setup script and idempotence/teardown receipts in progress |
| C — CDP recording of the real run | Preferred video deliverable | not built | Capture isolated surfaces and encode captioned MP4, ≤3 minutes |
| D — captioned frame-based video | Conditional recording alternative | not built | Use only if screencast fails; label still-frame pacing, never present it as continuous capture |

## Option A: managed dashboard + automatic per-member OAuth

**Run:** `pnpm world up acme-demo-eng105 --detach`, then follow [the 20-step operator script](eng-105-dashboard-demo.md) using the world's actual outputs. Alex creates **Acme Day** through Den Web's managed dashboard **Add app** flow and grants Jordan person-level access. Both desktops render the shared definition, but Personal Calendar executes through each member's separately connected OAuth identity. The calendar's synthetic authorization server auto-approves every authorization request, binds a fresh identity, and uses PKCE, signed tokens, and an audience guard. This can prove sharing and real host credential isolation, stable member identity across refreshes, incrementing generation, and an editable clock app. It does **not** prove production identity assurance, access to real personal calendars, or durable World Clocks storage across serverless cold starts. **State: Incomplete.**

## Option B: API-assisted dashboard setup

Deliverable H explicitly requests portable API setup. Public discovery confirms `/v1/dashboards`, `/{dashboardId}`, and `/{dashboardId}/access` routes; the setup worker is implementing `scripts/demo/setup-eng105-den.sh` against them. Its default apply path configures the Apps and named share; the local world's connections-only invocation leaves **Acme Day** creation to the operator so Option A still proves the UI journey. API setup can prove idempotent configuration and sharing, followed by separate real-desktop isolation assertions; it does **not** prove that an operator navigated every Den Web control. **Run: script implementation and verified commands are pending; do not replace Option A's UI verdict with an API receipt. State: Incomplete.**

## Option C: CDP screencast

Capture only the world-owned Alex/Jordan desktops and isolated Den Web profile; turn approved frames into a captioned MP4 of at most three minutes. This demonstrates the observed sequence and supports review of already asserted behavior. It does not itself establish pass/fail, and must exclude credentials and transient authorization URLs. **Run: recording command will be recorded with the actual artifact receipt; none is claimed yet. State: not built.**

## Option D: captioned frame-based video

If continuous CDP capture fails, assemble per-step PNGs from the same verified demo run into an explicitly labeled still-frame walkthrough, using Remotion if available. Keep captions aligned with actual observations and identify incomplete steps. This makes the delivered frames easy to watch; it does not prove continuous execution or replace missing test assertions. **Run: no runnable composition has been produced yet. State: not built.**

## Dropped or deferred forks

- **Two-button identity picker:** deferred; automatic OAuth approval is the final requested primary flow. Build this only after an actual auto-approval failure makes it a necessary alternative, within the six-option cap.
- **Shared calendar credentials:** dropped as an ENG-105 success option because they cannot prove per-member isolation. The initial API-key/per-member rejection can be retained as a diagnostic receipt, not a green fallback.
- **Chat “Save as app” / generated Workflow snapshots:** dropped; the agreed journey uses Den Web managed MCP App dashboards and live per-member tool execution.
- **Second independent model:** deferred unless it produces materially different results. Astra cannot be identified on the installed app without `models.list` (pending #4955). The approved reviewer fallback is the organization's default GPT-family model with variant `low`; omit the variant only if session creation rejects it. No obsolete local provider identifier is used.

At the 05:30 EDT calendar cutoff, preserve working Home/Clocks/world deliverables and name any remaining isolation gap explicitly. The final 07:30 report starts with an updated comparison table and contains exact run commands and evidence paths.
