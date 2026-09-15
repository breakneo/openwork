# ENG-105: a shared dashboard with personal data

**Status: Incomplete — operator script awaiting live verification.** Expected observations below are acceptance criteria, not a claim that the steps have passed. See [options and verification boundaries](eng-105-options.md).

This demo uses **Den Web to create and share a managed dashboard**, then two isolated desktops to view it. It does not save a chat result or copy a Workflow snapshot. The three real MCP Apps are Acme Home, World Clocks, and Personal Calendar (demo).

Personal Calendar uses a **demo authorization server — accepts every request**. Connect auto-approves a fresh synthetic identity, with no password or identity picker. Each member connects separately. The generated names are not the members' account names: record the name shown by each calendar, and compare them. Do not connect both members through the same signed-in Den browser profile. No real calendars or customer data are used. This authorization server is not suitable for production.

## Before starting

Run from the demo checkout with its documented toolchain and world prerequisites. Install both workspaces with `pnpm install --frozen-lockfile` and `pnpm --dir evals install --frozen-lockfile`. Use only the world-owned Den URL, desktop CDP endpoints, and separate browser profiles. Never attach to a personal running desktop.

**Placement: local.** The required `acme-demo` / `demo-org` seed has no Daytona placement implementation. Daytona service preflight succeeded, but the required topology was rejected before test execution; the approved proof lane is the exact local world, not a substituted cloud topology.

| App | Hosted MCP endpoint | Launch tool | Authentication |
|---|---|---|---|
| Acme Home | `https://acme-home-demo.vercel.app/mcp` | `acme_home {}` | none / shared |
| World Clocks | `https://world-clocks-six.vercel.app/mcp` | `show_world_clocks {}` | none / shared |
| Personal Calendar (demo) | Pending verified deployment receipt; use world outputs | Pending final contract | OAuth / per-member |

Acme Home source: [yomgui/acme-home-demo](https://github.com/yomgui/acme-home-demo), deployment source commit `aa0f1b7aaa72fe4d41d9f0ee9408b83c80b53575`. Its launch binds `ui://acme-home/home.html`. Hosted availability is not evidence that the Den sharing/isolation journey has passed.

```sh
pnpm world up acme-demo-eng105 --detach
```

Keep the world running throughout the script. Its outputs are the authority for `denWeb`, `denApi`, Alex/Jordan CDP URLs, member emails, registration receipts, and tool names. Read account passwords only from the world's private secret outputs; do not copy them into recordings, this document, or chat. Default local Den ports are API **8790**, Web **3005**; use actual outputs if placement changes them.

Calendar registration must say **OAuth / per-member**, not API key or shared credentials. The superseded API-key design is unsupported: Den requires an `apiKey` for `authType: apikey` and rejects `per_member` with non-OAuth authentication. Do not work around that by supplying an organization-wide calendar key.

### Local readiness receipt (historical, stopped)

The initial local smoke at **2026-09-15 00:44 EDT** reached Den API `http://localhost:8790`, Den Web `http://localhost:3005`, Alex CDP port `51858`, and Jordan CDP port `52099`. Both isolated desktops signed in; Jordan was `jordan@acme.test`. Home and World Clocks registrations returned HTTP 201. Calendar OAuth registration was still pending, so this was **not full scenario proof**. The world was stopped and ports released to the proof runner. These CDP ports are historical: obtain fresh outputs after each boot, never attach to these numbers blindly.

## Operator script (20 steps)

| # | Action | Expected observation |
|---|---|---|
| 1 | Start the world and inspect its outputs. | Den Web, Alex desktop, and Jordan desktop are reachable. Both members belong to the same demo organization; the desktops are signed in as different accounts. All three connection registrations succeeded. Stop and record any failed registration instead of claiming readiness. |
| 2 | In an isolated browser profile, open `denWeb` and sign in as Alex using the world's account outputs. | Alex is the organization owner. The admin navigation includes **Manage → Dashboards**. |
| 3 | Open the organization's connection inventory and inspect Acme Home, World Clocks, and Personal Calendar (demo). | All three expose an MCP App. Calendar is **Individual accounts / per-member** with OAuth. Its `ui://` resource is served by the Vercel app, not a generated Workflow view. |
| 4 | As Alex, open **My Library → MCPs → Personal Calendar (demo)**, which opens **Your Connections**, and click **Connect**. | The demo OAuth redirect returns without asking for a password or choosing a person. Alex's connection reports connected. A failed OAuth return is a failed step, not permission to use shared credentials. |
| 5 | Open **Manage → Dashboards → New dashboard**. Name it **Acme Day**, then click **Create dashboard**. | The dashboard detail page opens with an empty app list and access controls. |
| 6 | Click **Add app**, select the Acme Home connection and its Home App, then **Add → Done**. Enable **Auto-run** for its row. | Acme Home appears once in the saved app list, with automatic launch enabled. No chat “Save as app” step is involved. |
| 7 | Add the World Clocks App in the same way, using default launch arguments `{}`. Enable **Auto-run**. | World Clocks appears once. Do not supply `cities`, because explicit launch cities override saved preferences on refresh. |
| 8 | Add Personal Calendar (demo) with default launch arguments `{}` and enable **Auto-run**. | The calendar is a real MCP App tile bound to the per-member connection. Its launch arguments contain no identity, bearer token, or shared calendar payload. |
| 9 | Under **Who sees this dashboard**, leave **Everyone in the organization** off. Use **Add person → Search people...** to grant Alex and Jordan access individually, selecting each account by its world email and clicking **Grant**. | Named viewer grants list Alex and Jordan. Sharing applies to the dashboard definition; it does not copy Alex's calendar result to Jordan. |
| 10 | In Alex's isolated desktop, open **Dashboard**. | **Acme Day** appears under **From your company**, with Home, World Clocks, and Personal Calendar. Tiles launch automatically; launch/recovery controls may show **Organization auto-run**. |
| 11 | Read Alex's calendar. Record its **Signed in as** name, identity fingerprint, meeting titles, and generation as `A`. | A nonempty synthetic calendar is rendered from Alex's authenticated tool call. Preserve these values for comparison; do not assume the synthetic name is “Alex.” |
| 12 | Open `denWeb` in a second isolated browser profile and sign in as Jordan. | The signed-in account is Jordan, not Alex. This browser profile must not share Den authentication cookies with Alex's profile. |
| 13 | As Jordan, open **My Library → MCPs → Personal Calendar (demo) → Your Connections → Connect**. | OAuth auto-approves Jordan's separate connection and returns connected. No API key, password, or identity picker is required. |
| 14 | In Jordan's isolated desktop, open **Dashboard**; reload the dashboard if it was already open. | The same shared **Acme Day** dashboard and all three tiles appear without Jordan creating another dashboard. Home is visually neutral. |
| 15 | Read Jordan's calendar as `J`; compare it with `A`. | `J.name != A.name`, `J.identity != A.identity`, and the meeting sets differ. Both views show real successful tool results. Identical calendars fail ENG-105 even if sharing worked. |
| 16 | On Alex's calendar, open **App options for Personal Calendar (demo) → Refresh**. | A new tool invocation with the same stored `{}` arguments returns a generation greater than `A.generation`. Alex's identity and meeting set remain Alex's; a mere iframe repaint is insufficient. |
| 17 | Repeat calendar **Refresh** on Jordan's desktop. | Jordan's generation increases, while Jordan's identity remains unchanged and different from Alex's. No account switch or reconnect is needed. |
| 18 | On Alex's World Clocks tile, click **Edit**. In **Add a city**, choose a catalog city not already present (for example Tokyo), add it, and increase **Clocks shown** if needed so it is visible. | The selected city's name and IANA timezone appear. The editor is inside the App; this is not an edit to the dashboard's launch arguments. |
| 19 | Wait for World Clocks' successful save acknowledgment, then click **Done**. | **Saved (shared with everyone)** or **Saved to your account** confirms the `save_preferences` tool call succeeded. **Done** alone is not a save receipt; **Not saved** or **Unsaved changes** fails this step. |
| 20 | Use the World Clocks host **Refresh** action to launch `show_world_clocks` again with `{}`. | The added city and selected clock settings survive the fresh tool result and remount. This proves refresh persistence for the running deployment, not durability across a Vercel cold start. |

## Verification and recording

The test spec is `evals/specs/eng-105-dashboard-demo.e2e.test.ts`. A successful run must assert named sharing, different calendar identities and meetings, generation increments on repeated default launches, and the saved clock edit. **Zero skips** are required for a Passed verdict. API setup, if used by the proof harness, must be labeled separately from operator-UI coverage.

The independent reviewer receives only this document and sanitized world outputs after the coded proof is green. Record pass/fail for each numbered step. Repair the document or world after a failed review, then rerun; never change the report to make it pass.

Record only the isolated demo surfaces. Keep credentials and authorization URLs out of frames. Captions must distinguish Passed, Incomplete, and Failed observations. Screenshots and video illustrate the run but do not replace test assertions. A ≤3-minute recording can omit waiting time, but must not splice different identities into a false isolation result.
