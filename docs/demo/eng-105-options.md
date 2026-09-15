# ENG-105 demo options

This is the coordinator's option register. **At most six alternatives across the whole demo; four slots are currently listed, not four completed implementations.** Do not infer completion from an expected observation or a proposed command. Testkit assertions decide Passed; a recording alone does not.

| Option | Scope | Current state | What remains |
|---|---|---|---|
| A — managed dashboard + automatic per-member OAuth | Primary end-to-end ENG-105 scenario | Incomplete | Hosted calendar authorization server, world integration, coded proof, independent review |
| B — same scenario, dashboard created/shared via API | Portable setup requested in deliverable H | Incomplete | Public dashboard APIs discovered; setup script and idempotence/teardown receipts in progress |
| C — CDP recording of the real run | Preferred video deliverable | Incomplete | Tracked assembler exists; actual two-desktop footage and rendered MP4 pending |
| D — captioned frame-based video | Conditional recording alternative | Incomplete | Tracked Remotion composition exists; real PNGs and rendered MP4 pending |

## Option A: managed dashboard + automatic per-member OAuth

**Run:** `pnpm world up acme-demo-eng105 --detach`, then follow [the 20-step operator script](eng-105-dashboard-demo.md) using the world's actual outputs. Alex creates **Acme Day** through Den Web's managed dashboard **Add app** flow and grants Jordan person-level access. Both desktops render the shared definition, but Personal Calendar executes through each member's separately connected OAuth identity. The calendar's synthetic authorization server auto-approves authorization, binds a fresh identity, and uses PKCE, signed tokens, and an audience guard. The approved stateless design has replayable short-lived codes and per-instance generation, instance ID, and generated time. This can prove sharing, real host member isolation, stable identity, same-instance refresh increments, and a saved clock edit. It does **not** prove production authorization security, single-use codes, real-calendar access, distributed counter durability, or World Clocks cold-start storage. The primary remains exact v0.18.46 release-source with demo overlays, not packaged-binary verification. **State: Incomplete.**

## Option B: API-assisted dashboard setup

Deliverable H implements public API configuration of the three live App references in **`<prefix>ENG105 API Demo`**, plus named grants and optional invitation handling. The local world uses `--connections-only`, leaving **Acme Day** creation to the operator. **Run:** inject `DEN_API_URL`/`DEN_API_KEY` and private `DEMO_STATE_DIR`, then `bash scripts/demo/setup-eng105-den.sh --apply`; repeat to inspect stable IDs, then `--verify` or `--teardown` with the same state. See the operator document's Infisical examples. This can prove idempotent API setup and ownership-safe cleanup, not the UI authoring journey or desktop member isolation. Connection safety tests passed on the release tree; final full-API live/production receipts still await Calendar deployment. **State: Incomplete.**

## Option C: CDP screencast

Capture only the world-owned Alex/Jordan desktops and isolated Den Web profile; turn approved frames into a captioned MP4 of at most three minutes. This demonstrates the observed sequence and supports review of already asserted behavior. It does not itself establish pass/fail, and must exclude credentials and transient authorization URLs. **Run:** from `scripts/demo/video`, `pnpm assemble --manifest ../../../reports/demo/eng-105-2026-09-15/manifest.actual.json --validate-only`, then omit `--validate-only` to render in a logged background process. The manifest must identify actual A/B captures and matching release receipts; no real manifest/video exists yet. **State: Incomplete.**

## Option D: captioned frame-based video

If continuous CDP capture fails, assemble per-step PNGs from the same verified demo run into an explicitly labeled still-frame walkthrough, using Remotion if available. Keep captions aligned with actual observations and identify incomplete steps. This makes the delivered frames easy to watch; it does not prove continuous execution or replace missing test assertions. **Run:** use the same tracked assembler command as Option C, with variant `D` scenes pointing to actual PNGs. Its Remotion composition and manifest guards are committed; real footage and output remain pending. **State: Incomplete.**

## Dropped or deferred forks

- **Two-button identity picker:** deferred; automatic OAuth approval is the final requested primary flow. Build this only after an actual auto-approval failure makes it a necessary alternative, within the six-option cap.
- **Shared calendar credentials:** dropped as an ENG-105 success option because they cannot prove per-member isolation. The initial API-key/per-member rejection can be retained as a diagnostic receipt, not a green fallback.
- **Chat “Save as app” / generated Workflow snapshots:** dropped; the agreed journey uses Den Web managed MCP App dashboards and live per-member tool execution.
- **Second independent model:** deferred unless it produces materially different results. Astra cannot be identified on the installed app without `models.list` (pending #4955). The approved reviewer fallback is the organization's default GPT-family model with variant `low`; omit the variant only if session creation rejects it. No obsolete local provider identifier is used.

At the 05:30 EDT calendar cutoff, preserve working Home/Clocks/world deliverables and name any remaining isolation gap explicitly. The final 07:30 report starts with an updated comparison table and contains exact run commands and evidence paths.
