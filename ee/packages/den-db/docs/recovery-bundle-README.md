# OpenWork Den: finish MySQL migration 0097 after a partial upgrade

Bundle `openwork-mysql-0097-recovery` for OpenWork Den 0.18.48 deployments; its `drizzle/`
migration files are identical to the 0.18.48 release.
Verify it before use: `cd openwork-mysql-0097-recovery && sha256sum -c SHA256SUMS`.

## What happened

Upgrading OpenWork Den to 0.18.48 from an earlier release applies the pending database
migrations in order. Migration `0097_gateway_access_matrix` stops on MySQL servers that
run with `sql_require_primary_key=ON`: the statement at line 86 of the migration SQL,
`ALTER TABLE gateway_request_logs DROP PRIMARY KEY`, is rejected (`ER_TABLE_WITHOUT_PK`,
errno 3750). MySQL commits DDL statement by statement, so the four new tables, eight
table renames, seven column renames and index drops before that statement stay applied
while the migration ledger still holds exactly 96 receipts. Every retry of the Helm
migration Job then fails at the first statement with `ER_TABLE_EXISTS_ERROR` (errno 1050,
"already exists").

## What this bundle does and does not do

- It finishes ONLY migration 0097: it runs the 43 remaining original statements
  (original SQL lines 94 and 103-150) unchanged, skips only the eight DROP / ADD PRIMARY
  KEY pairs whose primary keys already exist, and records the original 0097 receipt.
  Your normal `helm upgrade` then runs 0098-0101 exactly as it would have.
- It never disables or changes `sql_require_primary_key`, never drops, adds or rebuilds
  a primary key, never drops tables, restores, deletes or edits migration receipts, and
  never reads or writes application data rows.
- It refuses to write unless the database is exactly the known failure state (or one of
  its exact partial completions), all twelve affected `gateway_*` tables are empty and
  every primary key is present. Without flags it only performs a read-only dry run.

Contents: `bin/recover-0097.mjs` (single-file tool for plain Node.js, nothing to install),
`drizzle/` (the release migration files the tool verifies; keep it next to `bin/`),
`sql/0097-preflight.sql` and `sql/0097-complete.sql` (reviewable SQL for Option B),
`SHA256SUMS`.

Requirements: Node.js 20 or newer (verified on 22 and 26; the `openwork-den-api` image
already contains it) and native MySQL 8.0.16-8.0.46 or 8.4.0-8.4.11 with strict SQL mode.
Other server platforms or version banners are refused by design (see the last section).

## Before either option

1. Take a verified, restorable backup of the database (schema and data).
2. Stop every writer: scale the `den-api`, `den-web` and `inference` Deployments to 0,
   suspend the release CronJobs, and make sure no Helm migration Job or hook is running
   or about to start.
3. Keep everything stopped until the normal upgrade has completed and been verified.

## Option A (recommended): run the tool inside your cluster

This reuses the den-api image you already run: no new image, registry or package install.

```sh
kubectl -n <namespace> run ow-0097-recovery --image=<mirror>/openwork-den-api:0.18.48 --restart=Never \
  --overrides='{"spec":{"containers":[{"name":"recovery","image":"<mirror>/openwork-den-api:0.18.48","command":["sleep","7200"],"envFrom":[{"secretRef":{"name":"<db-secret>"}}]}]}}'
kubectl -n <namespace> wait --for=condition=Ready pod/ow-0097-recovery --timeout=10m
kubectl -n <namespace> cp openwork-mysql-0097-recovery ow-0097-recovery:/tmp/recovery
kubectl -n <namespace> exec -it ow-0097-recovery -- node /tmp/recovery/bin/recover-0097.mjs
```

`<db-secret>` is the Secret your den-api Deployment reads `DATABASE_URL` from
(`<release>-secret` unless you configured `secret.existingSecret`). The last command is
the dry run: it connects, checks the server, schema, ledger and empty tables, prints the
recognized state (for example `Supported incomplete state: 0/43 safe-tail statements
complete`) and writes nothing.

If the dry run succeeds, apply interactively (`-it` is required):

```sh
kubectl -n <namespace> exec -it ow-0097-recovery -- node /tmp/recovery/bin/recover-0097.mjs --interactive
```

Choose `apply`, type the exact database name shown, and answer `yes` to the backup and
writers-stopped questions. The non-interactive equivalent, only when every
acknowledgment is true:

```sh
kubectl -n <namespace> exec ow-0097-recovery -- node /tmp/recovery/bin/recover-0097.mjs --apply --non-interactive \
  --confirm-database <database> --backup-confirmed --writers-stopped
```

Success ends with `0097 verified complete with its original receipt`. Running the dry
run again then reports `Read-only no-op: exact 97-receipt history ...`.

DATABASE_URL notes:

- If the tool reports `Invalid DATABASE_URL or insecure/unknown URL options`, your URL
  carries driver options the tool does not accept. Open a shell in the pod
  (`kubectl -n <namespace> exec -it ow-0097-recovery -- bash`), set the URL with only
  scheme, user, password, host, port and database without echoing it
  (`read -rs DATABASE_URL && export DATABASE_URL`, then type
  `mysql://<user>:<password>@<host>:<port>/<database>`), and run the tool from that shell.
  TLS with certificate and hostname verification is always enforced for non-loopback
  hosts; `sslmode=require|required|verify-ca|verify-full` and `sslaccept=strict` are the
  only accepted options.
- Private CA: copy the PEM into the pod
  (`kubectl -n <namespace> cp ca.pem ow-0097-recovery:/tmp/recovery/ca.pem`) and add
  `--ca-file /tmp/recovery/ca.pem` to every tool command.
- Never pass credentials as command arguments; the tool reads only `DATABASE_URL`.

After success:

1. `kubectl -n <namespace> delete pod ow-0097-recovery`
2. Re-run the exact same `helm upgrade ...` command that failed. It runs 0098-0101.
3. Verify the migration Job completed: `kubectl -n <namespace> get job <release>-migrate`
   shows `1/1` completions and its logs end without an error.
4. Scale den-api, den-web and inference back up and resume the CronJobs.

## Option B: your DBA runs the reviewed SQL

1. Run the read-only preflight (SELECT and SHOW statements only) against the database:
   `MYSQL_PWD=<password> mysql --protocol=tcp -h <host> -P <port> -u <user> --table --skip-comments -vv <database> < sql/0097-preflight.sql`.
   The flags echo each statement before its result and print `Empty set` for checks that
   expect no rows. Compare every result with the `Expected:` comment above its statement
   in the file and send the complete output to support for confirmation. Any mismatch
   means stop and use Option A or wait for guidance.
2. With writers still stopped and the preflight confirmed, run
   `MYSQL_PWD=<password> mysql --protocol=tcp -h <host> -P <port> -u <user> --skip-comments -vv <database> < sql/0097-complete.sql`
   without `--force`. The file contains the 43 remaining original statements plus the
   single receipt INSERT and no transaction wrapper, because MySQL DDL commits implicitly;
   the client stops at the first error. If any statement fails, stop and do not rerun the
   file: run the Option A dry run, which recognizes every partial state and resumes safely.
3. Continue with the "After success" steps 2-4 above.

## Verification

- The Option A dry run reports `Read-only no-op: exact 97-receipt history` before the
  Helm upgrade and `101-receipt history` after it.
- `SELECT COUNT(*) FROM __drizzle_migrations;` returns 97 before and 101 after the
  upgrade; `SHOW TABLES LIKE 'gateway%';` lists 12 tables;
  `SELECT @@sql_require_primary_key;` is unchanged.
- The migration Job is Complete, den-api / den-web / inference pods are Ready and your
  application smoke checks pass.

## If the tool refuses or fails

- Read the message. `Unsupported server` includes the observed `VERSION()` and
  `@@version_comment`: managed or forked MySQL banners are refused by design and need a
  reviewed update from support. Do not bypass the check.
- Rerun the dry run and send its complete output to support; it contains no credentials,
  SQL text or row data. Do not hand-edit SQL, receipts or schema, do not disable
  primary-key enforcement, do not use `--force`, and keep writers stopped.
- An interrupted apply is safe to inspect again: the dry run reports the exact remaining
  statements, or the read-only no-op if the receipt already committed.
