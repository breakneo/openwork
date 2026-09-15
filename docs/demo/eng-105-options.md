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

Deliverable H uses two explicit stages in **`<prefix>ENG105 API Demo`**: default apply creates auto-running Home + Clocks and named sharing; Calendar's 409 is retained as expected member-consent enforcement. After the calling member clicks Connect, `--after-connect` appends Calendar only to the untouched owned dashboard. The local world still uses `--connections-only` so **Acme Day** is authored through UI. **Run:** inject `DEN_API_URL`/`DEN_API_KEY` and private `DEMO_STATE_DIR`; invoke `bash scripts/demo/setup-eng105-den.sh --apply`, then (after consent) `--after-connect`, `--verify`, or `--teardown` using the same state. See the operator document's Infisical examples. This proves only the explicitly tested configuration/cleanup scope, not UI authoring or desktop member isolation. Bounded production connections-only provisioning/idempotence/cleanup passed; two-stage behavior is fixture-proven, with local live dashboard proof pending. The earlier full attempt's exit 1 is retained as an unmet-consent result, not a product bug. **State: Incomplete.**

## Option C: CDP screencast

Capture only the world-owned Alex/Jordan desktops and isolated Den Web profile; turn approved frames into a captioned MP4 of at most three minutes. This demonstrates the observed sequence and supports review of already asserted behavior. It does not itself establish pass/fail, and must exclude credentials and transient authorization URLs. **Run:** from `scripts/demo/video`, `pnpm assemble --manifest ../../../reports/demo/eng-105-2026-09-15/manifest.actual.json --validate-only`, then omit `--validate-only` to render in a logged background process. The manifest must identify actual A/B captures and matching release receipts; no real manifest/video exists yet. **State: Incomplete.**

## Option D: captioned frame-based video

If continuous CDP capture fails, assemble per-step PNGs from the same verified demo run into an explicitly labeled still-frame walkthrough, using Remotion if available. Keep captions aligned with actual observations and identify incomplete steps. This makes the delivered frames easy to watch; it does not prove continuous execution or replace missing test assertions. **Run:** use the same tracked assembler command as Option C, with variant `D` scenes pointing to actual PNGs. Its Remotion composition and manifest guards are committed; real footage and output remain pending. **State: Incomplete.**

## Shipped-host compatibility note

The shipped host drops app-visible tools without `ui.resourceUri` — the external fix is applied in canonical Clock source `0e0e70f32163687512c09e24ae68334a5a47dedd`: seven tools, four UI bindings, with app-only visibility and write annotations preserved. Proposed host improvement only: treat same-server app-only tools as bound to the launching resource. No OpenWork product change is included. The shipped native `save_preferences` confirmation must be accepted; auto-run is not helper-write approval.

**Deployment fork (b) was selected.** Original-team access failed with exact CLI text `Error: The specified scope does not exist`; the original project GET produced sanitized `{"status":403,"error":"forbidden"}`. The approved fallback deployed the fixed source to `prologe/world-clocks-demo`, deployment `CPS8WYLdK6W3PLoFE5Qea1HUDkAF`, URL **https://world-clocks-demo.vercel.app/mcp**. Initialize, seven-tool listing/four bindings, and resource read returned 200. Only tonight's world/setup/doc/spec target changed; `world-clocks-six` and the existing real-organization connector were not modified. Rollback tag `pre-resource-binding` points to `fc86788f0aad5f9ee083f6fdca4a67c43929b74c`. The legacy subtree carries the same code fix at `451d2d2cd39330b62286cbec7dc38947b2697508`.

### Morning actions — in priority order

1. Guillaume: **Connections → World Clocks (`emc_01m2gy1q…`) → change URL to `https://world-clocks-demo.vercel.app/mcp` → Refresh tools (7)**, then verify Edit/save; or Ben grants the ops token access to the original `team_J0n…` so its deployment can be updated. This is an admin follow-up, not an action performed by the demo agent.
2. Decide visibility and organization transfer for the three demo source repositories: Acme Home public, Personal Calendar private, World Clock Dashboard local. Guillaume decides; transfer to `different-ai` needs Ben. No public Calendar publication or organization transfer occurred tonight.

## Dropped or deferred forks

- **Two-button identity picker:** deferred; automatic OAuth approval is the final requested primary flow. Build this only after an actual auto-approval failure makes it a necessary alternative, within the six-option cap.
- **Shared calendar credentials:** dropped as an ENG-105 success option because they cannot prove per-member isolation. The initial API-key/per-member rejection can be retained as a diagnostic receipt, not a green fallback.
- **Chat “Save as app” / generated Workflow snapshots:** dropped; the agreed journey uses Den Web managed MCP App dashboards and live per-member tool execution.
- **Second independent model:** deferred unless it produces materially different results. Astra cannot be identified on the installed app without `models.list` (pending #4955). The approved reviewer fallback is the organization's default GPT-family model with variant `low`; omit the variant only if session creation rejects it. No obsolete local provider identifier is used.

At the 05:30 EDT calendar cutoff, preserve working Home/Clocks/world deliverables and name any remaining isolation gap explicitly. The final 07:30 report starts with an updated comparison table and contains exact run commands and evidence paths.
