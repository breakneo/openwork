# ENG-105: a shared dashboard with personal data

**Status: Incomplete — full UI proof and independent review pending.** The observations below are acceptance criteria, not passed results. See [options and verification boundaries](eng-105-options.md).

Den Web creates and shares a managed dashboard; two isolated desktops render its real MCP Apps. No chat “Save as app,” generated Workflow snapshot, or shared calendar credential substitutes for this journey. Home and World Clocks are demonstrated first so their working path remains observable if Calendar is blocked.

## Build, placement, and startup

Use the prepared **release-based** checkout `/Users/guillaume/Dev/openwork-eng105-release`, branch `demo/eng-105-release`. Product source must equal **v0.18.46**, SHA `a0d6bd1de8debf4f09d22b8538e124b2ff45b339`; only demo world/docs/setup/spec overlays are allowed. The world checks actual source provenance before boot.

The required seeded topology cannot inject release images or use Daytona placement. The approved lane is **local-release-source**, not packaged-binary validation. A later development checkout is not release proof. Shipped tiles use a visible header **Refresh** button, not the newer compact App-options menu.

```sh
pnpm install --frozen-lockfile
pnpm --dir evals install --frozen-lockfile
pnpm world up acme-demo-eng105 --detach
```

For automated execution, launch long boot/test/render commands detached or in an owned background process with a log and exit receipt; poll in short calls. Do not kill or attach to another session's processes. Keep the world alive for the operator run, and stop only your world with `pnpm world down acme-demo-eng105` afterward.

World outputs are authoritative for `releaseTag`, `releaseSha`, `lane`, `denWeb`, `denApi`, both desktop CDP endpoints, account emails, `registrations`, `reapplyRegistrations`, and `setupExitCodes`. Read passwords only from private secret outputs, never copy them to chat, docs, or recordings. Default Den API/Web ports are **8790/3005**. Alex and Jordan must use separate Den browser profiles and different desktop profiles.

| App | Hosted MCP endpoint | Launch | Account mode |
|---|---|---|---|
| Acme Home | `https://acme-home-demo.vercel.app/mcp` | `acme_home {}` | none/shared |
| World Clocks | `https://world-clocks-six.vercel.app/mcp` | `show_world_clocks {}` | none/shared |
| Personal Calendar | `https://personal-calendar-demo-mcp-app.vercel.app/mcp` | `show_calendar {}` | OAuth/per-member; `calendar:read` |

Home source: [yomgui/acme-home-demo](https://github.com/yomgui/acme-home-demo), verified deployment source `aa0f1b7aaa72fe4d41d9f0ee9408b83c80b53575`; UI resource `ui://acme-home/home.html`. Calendar's verified deployment source is `54a5f6e`, resource `ui://personal-calendar/mcp-app.html`, issuer `https://personal-calendar-demo-mcp-app.vercel.app`, with public-client DCR (`token_endpoint_auth_method: none`). Direct deployed OAuth/tool tests succeeded for two different synthetic identities; that is not yet proof of isolation through the released OpenWork host.

### Calendar's deliberately limited demo authorization

The embedded **demo authorization server — accepts every request** auto-approves a fresh synthetic identity without a password or picker. Signed, short-lived authorization codes are PKCE-bound but **not single-use**. Access tokens are verified for signature, issuer, and the Calendar resource audience. This is not production-grade identity assurance or a full OAuth 2.1 security claim.

Each member clicks Connect independently. Their displayed synthetic names are derived from separate token subjects, not the account names “Alex” and “Jordan.” Record the displayed names, fingerprints, and meetings. No real calendar data is used.

Refresh uses a **per-instance generation counter**, plus visible `instanceId` and `generatedAt`. It is not a durable/distributed counter: generation must increase on the same instance, but can reset on a new Vercel instance. Record that transition explicitly; never silently relabel a reset as an increment. Identity and meeting isolation must hold across instances.

### Historical local readiness receipt — stopped

A release-source smoke on overlay `0ffdedc85` booted v0.18.46 in 1m49s: Den API/Web **8790/3005**, signed-in `alex@acme.test` and `jordan@acme.test`, Alex/Jordan CDP **55559/55810**. All three connection PUTs returned **201**, then **200** on reapply with stable IDs and empty changed-field lists; exit codes `[0,0]`. Calendar was OAuth/per-member, organization-wide, and not connected for either member. That checkpoint used the earlier `calendar.read` scope; the final script uses **`calendar:read`**, requiring a fresh final receipt.

That world is stopped. CDP ports above are historical—never attach blindly. This is configuration readiness, not C's full UI proof. An earlier development-source smoke is excluded from release validation.

## Operator script (20 steps)

| # | Action | Expected observation |
|---|---|---|
| 1 | Start the world and inspect build/setup outputs. | Exact release SHA, two different signed-in members, three successful connection registrations, and successful stable-ID reapply. Record failures rather than claiming readiness. |
| 2 | In an isolated browser profile, open `denWeb` and sign in as Alex using private world outputs. | Alex is the organization owner; **Manage → Dashboards** is available. |
| 3 | Open the organization's connections page and click **Configured** to inspect installed connections rather than the connector catalog. | Acme Home, World Clocks, and Personal Calendar are registered. Calendar is **Individual accounts / per-member**, OAuth—not a shared API key. Registration alone does not mean it is connected. |
| 4 | Open **Manage → Dashboards → New dashboard**, name it **Acme Day**, and click **Create dashboard**. | An empty dashboard detail page with app/access controls opens. |
| 5 | **Add app → MCP → Acme Home → Add → Done**; enable **Auto-run**. | One Home App reference is saved. No chat-save step is used. |
| 6 | Add World Clocks with default `{}` and enable **Auto-run**. | One clock App reference is saved. Do not supply `cities`: explicit launch cities override saved preferences. |
| 7 | Under **Who sees this dashboard**, leave **Everyone in the organization** off. **Add person → Search people...**, select Alex and then Jordan by world email, and **Grant** each. | Exactly the named viewer grants exist; sharing stores App references, not another member's calendar data. |
| 8 | Open **Dashboard** in Alex's isolated desktop. | **Acme Day**, Home, and live World Clocks render under **From your company**. Launch controls may say **Organization auto-run**. |
| 9 | In a second isolated browser profile, sign in to `denWeb` as Jordan. | Jordan's account is visible; no Alex authentication cookie is reused. |
| 10 | Open **Dashboard** in Jordan's isolated desktop. | The same shared dashboard, Home, and World Clocks render without Jordan creating a dashboard. |
| 11 | In Alex's World Clocks, **Edit → Add a city**. Select an absent city, e.g. Tokyo, and increase **Clocks shown** if needed. | The new city and IANA timezone are visible; this edits the App, not stored launch arguments. |
| 12 | Wait for the successful clock save message, then click **Done**. | **Saved (shared with everyone)** or **Saved to your account** confirms the server tool acknowledged the edit. Done alone is not a save receipt. |
| 13 | Click the clock tile-header **Refresh** (`Refresh World Clocks`). | A fresh `show_world_clocks {}` result still shows the added city/settings. This does not establish cold-start storage durability. |
| 14 | As Alex in Den Web, open **My Library → MCPs → Personal Calendar → Your Connections → Connect**. | The demo OAuth redirect auto-approves and returns connected. No typing, identity picker, or shared credential is used. A failed return fails this step. |
| 15 | As Alex, reopen Acme Day's Den Web detail and add Personal Calendar with `{}`; enable **Auto-run**. | The third App is a real `ui://` Calendar reference. Launch arguments contain no identity, bearer token, or copied payload. Existing named grants remain unchanged. |
| 16 | As Jordan in the separate Den Web profile, open **Your Connections → Personal Calendar → Connect**. | Jordan's independent OAuth connection returns connected. No code/token from Alex's flow is reused. |
| 17 | Reopen/reload the dashboard on both desktops to load the new tile. | Both render **Signed in as** with a nonempty synthetic calendar, identity fingerprint, meetings, generation, instance ID, and generated time. |
| 18 | Record Alex's view as `A` and Jordan's as `J`; compare them. | `A.name != J.name`, `A.identity != J.identity`, and meeting sets differ. Identical calendars fail ENG-105 even when sharing worked. |
| 19 | Click Alex's visible calendar-header **Refresh** (`Refresh Personal Calendar`). | A new tool call uses unchanged `{}`. Identity/meetings remain Alex's. Generation increases on the same instance; if the instance changed, record its reset explicitly and do not claim durable monotonicity. |
| 20 | Repeat Calendar **Refresh** on Jordan's desktop and compare again. | Jordan's identity/meetings stay Jordan's and differ from Alex's; the same-instance generation rule holds. No reconnect/account switch is required. |

## Reproduce on another Den

**H status: connection and full dashboard/member API setup are implemented; live full-API/production receipts remain pending.** Default apply creates the separately named **`<prefix>ENG105 API Demo`**, never Acme Day. A printed `MANUAL_STEP` is not completed dashboard setup.

Prerequisites: Den **≥0.18.43**, dashboard feature enabled, a target-org admin API key, Bash, curl, jq, and Infisical configured for your authorized project when using these commands. Check the route:

```sh
curl -sS "$DEN_API_URL/openapi.json" | jq '.paths|has("/v1/mcp-connections/by-key/{externalKey}")'
```

Inject `DEN_API_KEY` through the environment, never command arguments or committed files. Set `INFISICAL_DEMO_PATH` to an authorized folder containing it. Preserve a separate private `DEMO_STATE_DIR` for each target/prefix through teardown. Optional `DEMO_EXPECTED_ORG_ID` refuses the wrong org; `DEMO_TEAMMATE_EMAIL` opts into member/invitation handling and named sharing (omit to invite nobody). Existing invitations are preserved; an invited teammate must accept before a rerun can add their named dashboard grant.

```sh
export DEN_API_URL="https://den.example.com"
export DEMO_KEY_PREFIX="demo-eng105-"
export DEMO_STATE_DIR="$HOME/.local/state/eng105-den-example"
# Set INFISICAL_DEMO_PATH to your authorized secret folder.

infisical run --env dev --path "$INFISICAL_DEMO_PATH" --silent -- bash scripts/demo/setup-eng105-den.sh --apply
infisical run --env dev --path "$INFISICAL_DEMO_PATH" --silent -- bash scripts/demo/setup-eng105-den.sh --verify
infisical run --env dev --path "$INFISICAL_DEMO_PATH" --silent -- bash scripts/demo/setup-eng105-den.sh --teardown
```

Apply a second time to verify **PUT 200s**, unchanged IDs, and empty diffs. Base keys: `acme-home-demo`, `world-clocks-demo`, `personal-calendar-demo`; all have organization-wide access and direct exposure disabled. Optional endpoint overrides: `DEMO_HOME_URL`, `DEMO_CLOCKS_URL`, `DEMO_CALENDAR_URL`, `DEMO_CALENDAR_ISSUER`; `DEMO_CALENDAR_SCOPES` is a JSON array. Conflicting existing identity/auth/issuer/scopes or unreadable grants are preserved, not silently migrated.

Stdout is a sanitized JSON array; stderr carries a table/diff/manual steps. On versions without by-key GET, an exact 404 is recorded, followed by public list/detail lookup matching `externalKey` exactly. A 401/403/server error never authorizes fallback. `connected: unknown` means the field was absent, not success.

**Manual on every Den:** each member separately clicks Calendar **Connect**. If dashboard APIs are absent, use steps 4–7 and 15; the script prints the manual requirement. The local world calls the same script with `--connections-only` twice, leaving dashboard creation/sharing to the primary UI journey.

Teardown uses the owner manifest, deleting only resources recorded as created; existing resources and replacement IDs are preserved. It never removes a member because an invitation was accepted. Production proof uses `rsproof-eng105-` and an explicit expected-org guard, then cleans up only its resources.

## Verification and recording

C's spec: `evals/specs/eng-105-dashboard-demo.e2e.test.ts`. H's safety spec: `evals/specs/eng105-setup-script.test.ts`. **Zero skips** and observable assertions for every claimed behavior are required for Passed. Setup/API receipts do not replace desktop rendering or the separate UI journey. Do not present per-instance counters as durable ones.

Only after C is green does a fresh independent reviewer receive this document and sanitized world outputs. Astra is not identifiable without `models.list` (#4955); the approved fallback is the org-default GPT-family model, variant low. Record pass/fail per step; fix the doc/world after failure and rerun, never edit a report into a pass.

Video tooling lives in `scripts/demo/video/`; actual PNGs/MP4s remain under `reports/demo/eng-105-2026-09-15/`. Use real isolated desktop footage, ≤3 minutes, excluding credentials and authorization URLs. Label API setup, still-frame assembly, instance resets, and incomplete steps. Videos illustrate the run; test evidence determines the verdict.
