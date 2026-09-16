# Opt-in recovery of the original MySQL 0097 partial upgrade

## Scope and evidence

This runbook supersedes advice to disable `sql_require_primary_key`, execute an
unverified SQL tail and manually stamp the migration journal. **Never disable
primary-key enforcement. Never restore, drop, baseline, delete receipts or edit
migration history automatically.** Do not use `db:push`, `db:baseline`, manual
receipt insertion, or blanket `IF NOT EXISTS` to get past an error.

A controlled reproduction using native MySQL **8.4.11** with
`sql_require_primary_key=ON`, upgrading a **0.18.35** bootstrap to **0.18.48**,
failed at original SQL line **86**, `DROP PRIMARY KEY` on
`gateway_request_logs`. MySQL had already committed the four CREATE TABLEs,
eight table renames, seven column renames and index drops through line 85.
The ledger remained the exact original 96-receipt prefix. Replaying 0097 then
failed because the first table already existed. DDL commits are not undone by
the surrounding migration transaction failing.

This reproduction does **not** establish the state of another installation,
prove that its original application is broken, or establish parity with any
operator-managed database platform. Inspect the actual database. Do not infer
that a Helm rollback is safe from schema inspection alone: table/column renames,
application versions and persisted data can make rolling back unsafe.

This is a separately invoked recovery tool, **not** an automatic bootstrap fix.
It finishes only 0097. It neither installs a fresh database nor runs 0098+.

## Supported inputs and refusals

The source checkout must retain these artifacts, without editing them:

| Artifact | Identity |
| --- | --- |
| `drizzle/0097_gateway_access_matrix.sql` | SHA-256 `96e872e1fdf004ff4cdf66715a589a442dff80170f2b47e70204b38a2fd09470` |
| Original 0097 timestamp | `1788895934602` |
| `drizzle/meta/0096_snapshot.json` | SHA-256 `62c1d2787cd6064a258238dfc1c066bfa3bde1dbf4a33b4ebc8f1af906a74282` |
| `drizzle/meta/0097_snapshot.json` | SHA-256 `64a86086082e0906028aa0064514658ebee7a8fe2b0ecb2e6f589e61b9fca5b5` |
| `drizzle/meta/_journal.json` | SHA-256 `ab0233a9c568dea31b9d53499cba470eaf8fc07c257f16858018f73904dfaa14` |

A further manifest pin covers the SQL hashes, timestamps, tags and parsed
snapshot identities for the entire reviewed 0001–0101 chain. Changed, missing,
reordered, superseded or extended artifacts are refused. This tool intentionally
needs review before being used with a newer artifact set. Artifact pins verify
consistency, not authenticity of an untrusted checkout; obtain a reviewed copy.

For **incomplete recovery**, all of the following must hold:

- The ledger has exactly the canonical first 96 hash/timestamp receipts in ID
  order. IDs must be positive and strictly increasing, but need not be contiguous.
- The complete normalized application schema matches the projection of 0096
  plus original statements through line 85, or one of the 43 reachable safe-tail
  prefixes. The fully applied 0097 schema without its receipt is also a supported
  interruption state. Earlier CREATE/rename/index-drop failures are not supported.
- All twelve affected gateway tables are empty: `gateway_credential_sets`,
  `gateway_keys`, `gateway_model_group_models`, `gateway_model_groups`,
  `gateway_request_logs`, `gateway_rollup_lock`, `gateway_usage_rollups`,
  `gateway_provider_access`, `gateway_provider_credentials`,
  `gateway_provider_models`, `gateway_provider_oauth_states`, `gateway_providers`.
  This preserves the original empty-source contract, not a data migration promise.
- All eight renamed tables still have the canonical primary key on `id`, and
  unchanged `id` definitions. The tool omits **only** the eight DROP PRIMARY KEY
  and eight ADD PRIMARY KEY statements. It never repairs a missing primary key.
- No unexpected tables, views, columns, indexes, CHECKs, foreign keys, triggers,
  partitioning, invisible/spatial column metadata or database events exist.
  An existing local migration state table is refused, even if empty.
- The ledger itself has the native InnoDB serial-ID/hash/timestamp layout (the
  redundant unique `id` index produced by SERIAL is allowed). It is never rebuilt.

Recognition uses metadata from the pinned snapshots, not a guessed hand-written
tail. It compares the entire schema, including unrelated application tables;
it does **not** use the local baseline helper's broad known-repair exceptions.
Consequently, even otherwise legitimate fulltext/schema-repair variations can
be refused. Do not remove those objects to fit this tool: seek a separately
reviewed recovery. Normalization covers types, nullability, defaults,
auto-increment/on-update presence, index columns/prefixes/order/uniqueness/type,
and enforced CHECK logic. Snapshots do not specify all physical options, table
collations or column order; this is not a byte-for-byte SHOW CREATE TABLE audit
or validation of application data. Review physical/platform differences separately.

A canonical **0097–0101 completed** history is a **read-only no-op**, even when
`--apply` was requested. The tool checks the full known history and normalized
schema against the snapshot for its last receipt before reporting that no-op.
It does not require empty gateway tables in completed installations. Drift after
a completed receipt is refused without mutations, not treated as another
incomplete recovery. Unknown later history is refused. No application health
claim follows from a successful metadata check.

## Prerequisites and operator responsibilities

1. Arrange an approved maintenance window and a verified, restorable backup of
   schema **and data**. Rehearse against an isolated restored copy first. Have a
   human-approved restore plan; the script never restores automatically.
2. Pause every writer and competing schema tool: app/API/gateway replicas,
   controllers, workers, scheduled jobs/cronjobs, ad hoc jobs, callback/webhook
   consumers, OAuth callbacks, CI deploys, Helm migration Jobs and pre/post hooks.
   Prevent controllers and deployment automation from recreating them. Keep them
   paused until normal migrations and post-upgrade validation finish.
3. Use a native writable primary: supported parser bounds are MySQL **8.0.16
   through 8.0.46**, or **8.4.0 through 8.4.11**, with strict SQL mode and session
   autocommit enabled. Native MySQL Community/Enterprise version banners and
   the specifically tested Homebrew **8.4.11** build are accepted. MariaDB, TiDB,
   Vitess/PlanetScale, Aurora, other compatibility layers, unknown banners,
   read-only replicas and other versions are refused. A managed service may use
   a different version banner and be refused even when it is MySQL-compatible;
   the refusal message includes the observed `VERSION()` and `@@version_comment`
   so operators can report them. Do not bypass the guard: validate that exact
   platform on an isolated restored copy and obtain a reviewed update first.
   These bounds are compatibility guards, **not evidence every version or
   managed service was tested**.
4. Use an account with direct database-wide `SELECT`, `SHOW VIEW`, `TRIGGER`,
   `EVENT`, `REFERENCES` grants (or `ALL PRIVILEGES`) for complete metadata
   visibility. Role-only grants are deliberately unsupported. Apply additionally
   needs ALTER/INDEX on affected tables and INSERT on the ledger. Configure
   privileges separately; this tool does not grant anything.
5. `PROCESS` is recommended for visibility of other users' sessions. The
   processlist check refuses other visible connections, including idle ones, but
   without PROCESS it may see only the current account. Even with PROCESS, a
   connection can arrive after the check. The database-specific named lock
   coordinates only this tool and cooperating local migration runners. **It does
   not block ordinary app queries, the ORM migrator, Helm Jobs or administrators.**
   Writers-paused acknowledgment and external isolation are essential.
6. Obtain the reviewed source checkout and install its locked repository
   dependencies using the repository's pnpm version. The command below requires
   `tsx`, `mysql2`, `drizzle-orm` and `drizzle-kit` from repository dependencies;
   the reused migration helpers import drizzle-kit. It does not import the app
   schema, bootstrap, generate migrations, or load `.env` files automatically.
   **This source script is not present in the released 0.18.48 image.** No Helm
   hook is installed by this change. Do not point an existing image at a
   nonexistent recovery binary or assume production-pruned dependencies can run
   it. Use the reviewed checkout in a secured operator environment, or build the
   customer-deliverable bundle described below and copy it into an existing pod.

## Connection and command interface

Run the following commands from the repository root. Supply `DATABASE_URL`
through an approved secret-injection mechanism or protected environment, never
as a command-line argument or copied into logs. There is no URL/password flag
and no fallback to `DATABASE_HOST` variables. Do not enable shell tracing.

The database name must be 1–64 ASCII letters, digits, `_`, `$` or `-`; the exact
selected name is required for confirmation. The CLI displays only the safe
host, port and database, not the URL, user or password.

For remote hosts, TLS is always enabled with CA verification **and hostname
verification**, even if the URL omits TLS settings. Optional URL settings are
`sslaccept=strict`, or `sslmode`/`ssl-mode` set to `require` (alias `required`),
`verify-ca` or `verify-full`; values are matched case-insensitively and all are
upgraded to full identity verification. Unknown, duplicate, conflicting alias or
insecure options are rejected, including `ssl=false`,
`sslaccept=accept_invalid_certs` and `rejectUnauthorized=false`.
Loopback can use plaintext for isolated rehearsals; do not use a loopback tunnel
to bypass remote TLS requirements. `--ca-file /absolute/path/to/ca.pem` supplies
a trusted PEM CA bundle if the server is not signed by a default trusted CA.
It does not disable certificate or hostname checks.

```bash
pnpm --dir ee/packages/den-db db:recover:mysql-0097 --help
pnpm --dir ee/packages/den-db db:recover:mysql-0097
pnpm --dir ee/packages/den-db db:recover:mysql-0097 --dry-run --non-interactive
pnpm --dir ee/packages/den-db db:recover:mysql-0097 --interactive
pnpm --dir ee/packages/den-db db:recover:mysql-0097 --apply
```

Equivalent source invocation from the package directory:

```bash
pnpm exec node --import tsx scripts/recover-mysql-0097.ts --dry-run
```

- No mode flag means **dry-run**, even on a TTY. Dry-run performs SELECTs and
  SHOW GRANTS only: no DDL/DML, session SETs, transactions or named locks.
- `--interactive` requires stdin and stdout TTYs. The wizard offers dry-run,
  apply or cancel, defaulting to dry-run. Apply asks for the exact database name,
  then separate `yes` confirmations for backup and stopped writers. Blank or
  incorrect write confirmations cancel safely. `--apply` on a TTY also asks
  these confirmations unless `--non-interactive` is supplied.
- `--non-interactive` never prompts. Non-TTY apply without that flag is refused.
  All write acknowledgments below are mandatory; replace the synthetic database
  name with the exact selected name. Only use acknowledgments when true.

```bash
pnpm --dir ee/packages/den-db db:recover:mysql-0097 --apply --non-interactive \
  --confirm-database recovery_copy --backup-confirmed --writers-stopped
```

Add `--ca-file /absolute/path/to/ca.pem` to any database command when needed.
Do not combine mode flags or duplicate options. There is no force, restore,
drop, baseline, skip-error or disable-enforcement option.

## Customer-deliverable bundle

`pnpm --dir ee/packages/den-db build:recovery-bundle` (from a checkout whose
`drizzle/` is byte-identical to the commit; the script refuses otherwise) writes
`dist/recovery-bundle/openwork-mysql-0097-recovery/` and
`dist/recovery-bundle/openwork-mysql-0097-recovery-<short-sha>.zip`:

- `bin/recover-0097.mjs`: `tsup.recovery.config.ts` bundles this CLI with
  `mysql2`, `drizzle-orm/migrator` and the repository helpers into one ESM file
  for plain Node 20+ (`drizzle-kit` is external and only referenced by the
  unused `foundationSql` dynamic import, so it is never loaded). It resolves
  `../drizzle` relative to `bin/`, exactly like the source script.
- `drizzle/`: exact copy of the committed migration assets; the build verifies
  the recovery pins against the copy.
- `sql/0097-preflight.sql` and `sql/0097-complete.sql`: generated by
  `scripts/recovery-0097-sql.ts` from the pinned artifacts (the 43 safe-tail
  statements byte-for-byte plus the single original receipt INSERT), for DBAs
  who prefer reviewed SQL over running the tool.
- `README.md` (from `docs/recovery-bundle-README.md`) and `SHA256SUMS`.

The `mysql-upgrade` world accepts `--recovery-bundle <dir>` (and optionally
`--recovery-node <path>`) to exercise the built bundle and the SQL file against
real MySQL instead of the source checkout.

## Apply, interruption and completion

Apply reinspects after human confirmations and again after obtaining the
DB-specific named lock; it never applies the stale pre-confirmation plan. It
checks visible competing sessions, verifies the full schema/history and twelve
empty-table probes, then executes only remaining exact safe-tail statements,
once each. Duplicate-object errors are failures, not ignored successes.

The connection timeout is 10 seconds. Queries have a 30-second client timeout;
apply sets session metadata and InnoDB lock waits to 15 seconds. No global
variables or primary-key enforcement settings are changed. A client timeout
can leave server-side DDL finishing: wait for it to settle before another
inspection. There are no automatic uncertain retries.

After DDL, the full target 0097 schema, emptiness and unchanged original 96
receipts are rechecked. Inside a transaction while still holding the named lock,
the tool locks and rechecks all original receipts, repeats target schema and
emptiness verification, and inserts **one** receipt with the original SQL hash
and timestamp above. It never updates or deletes a receipt. It commits, then verifies history/schema again before reporting success.
Unrelated data, including any organization validation marker, is not queried or
modified by recovery SQL. Validate your marker through your own approved checks.

Ctrl-C/SIGTERM closes prompts and the connection. Normal failures roll back a
pending receipt transaction and release the named lock in cleanup; disconnect
also releases session locks once MySQL finishes processing the session. DDL may
already have committed, including a statement whose response was lost. A lost
COMMIT response can also mean the receipt committed. Never assume cancellation
means nothing happened. The tool exits nonzero on failure, prints sanitized
MySQL code/errno/sqlState when available, and withholds SQL/error text/row values.
Record only this sanitized result and safe prefix information, not secrets.

After **any failure or interruption**:

1. Keep writers and deploy automation paused. Confirm the prior server session
   has finished and any lock has been released; do not automatically kill it.
2. Run `--dry-run` again. If the actual state is an exact supported prefix,
   review a fresh plan and explicitly authorize apply again. If the prior
   receipt committed, the next run reports the verified read-only no-op.
3. If recognition fails, stop and involve the migration owner using a restored
   copy and sanitized metadata. Do not patch missing keys, delete unexpected
   objects, clear state tables, alter hashes, restore automatically, or run a
   hand-cut tail to satisfy the recognizer.
4. After successful 0097 recovery, keep writers paused while the normal,
   version-pinned Helm migration/bootstrap path runs **0098+**. Fresh installs
   also belong to that normal path, never this recovery tool. This runbook does
   not invent chart/release-specific Helm commands; use your reviewed release
   configuration and verify the migration Job completed before enabling traffic.
5. Validate schema, receipts, application compatibility, health, callbacks,
   workers and approved data markers before resuming. A recovery receipt alone
   is not rollout approval or evidence that rollback is safe.

## Verification and remaining boundaries

The isolated `mysql-upgrade` world, with `--recovery`, passed **37 checks** on
Homebrew MySQL **8.4.11** and Node **26.8.1**, with no failures or skips:

- The four original upgrade/retry cases, with primary-key enforcement ON/OFF
  and original CLI/diagnostic bootstrap variants.
- Actual recovery CLI default/dry-run inspection with unchanged schema, full
  synthetic application-data digests, receipts, primary keys and settings;
  MySQL query logs confirmed read-only execution.
- Correct non-interactive recovery to receipt 97, original 0.18.48 bootstrap
  completion through receipt 101, stable reruns, and verified completed no-ops.
- Refusal of missing confirmations, wrong database, nonempty gateway tables,
  unexpected schema, missing primary keys and changed migration history.
- Recovery after injected executor failures at a partial safe-tail prefix and
  before/after the uncommitted receipt insertion, using real MySQL followed by
  a fresh CLI process. These are not actual network-loss or process-crash tests.
- Real terminal flows through a pseudo-TTY: default dry-run, explicit dry-run,
  cancel, wrong database, Ctrl-C, EOF and fully confirmed interactive apply.
- Refusal of changed literal defaults and CHECK literal contents, with native
  metadata readback and unchanged database state after refusal.

The **30 recovery unit tests** and **5 harness unit tests** passed without
failures or skips. Recovery tests cover every projected safe-tail prefix,
artifact/history pins, confirmation and readline lifecycle, sanitized errors,
receipt ordering, ambiguous-response handling with synthetic executors, the
generated bundle SQL (safe tail plus receipt; read-only preflight) and
symlink-safe entry detection.
The existing selected **26 local-migration safety tests** also passed after the
shared normalization hardening. Targeted type and dependency-layer checks
passed; this is not a repository-wide green-check claim.

The world uses exact release **source** with installed workspace dependencies,
not published container bytes or fresh release-lockfile dependency installs.
It never connects to production and its disposable databases are removed after
verification. It is not a restored copy of any deployed installation.

**Still required before operational use:** validate the actual supported
server/build and permissions against an isolated restored copy, remote TLS/CA
handshakes, deployment-specific writer isolation, the normal Helm upgrade,
and application/data health. Do not treat local matrix success as managed
platform certification or permission to bypass a failed preflight.
