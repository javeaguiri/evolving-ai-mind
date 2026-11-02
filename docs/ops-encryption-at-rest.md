# Encryption at Rest Runbook

Operational procedure for encrypting the prod PostgreSQL instance on disk — `docs/arch-security.md`
F7, Sprint 15 AC1. Written 2026-11-02. **Agreed before any AWS action; no step below has run until
its phase is marked done in `docs/sprints/sprint-15.md`.**

**This document never contains a secret value.** Every database command reads its connection
string from SSM inside a command substitution, so no password reaches a transcript or a history file.

---

## 0. Facts this plan rests on (read live 2026-11-02)

| Fact | Value | Consequence |
|---|---|---|
| Instance | `sysrdsevomind`, `db.t4g.micro`, single-AZ `us-east-2a`, gp2 20 GB, public | The restore reproduces each of these explicitly — a restore takes defaults, not the source's settings |
| `StorageEncrypted` | `false`, no KMS key | Cannot be switched on in place: snapshot → encrypted copy → restore |
| Engine | **16.13** live; `template.yaml` says `"16.6"` | Auto minor upgrades moved it; the template is already out of line with the live instance |
| Endpoint | `sysrdsevomind.cx8eoo8eaw8h.us-east-2.rds.amazonaws.com` | Both SSM URLs (`pgc-database-url:4`, `pgd-database-url:3`) name this host; the endpoint follows the instance identifier, so the restored instance **renamed to `sysrdsevomind`** keeps it and no SSM parameter changes |
| Database | One database, `evo_mind`, 30 tables, 101 MB, owned by `lambda_user` | `lambda_user` can freeze writes (§3.1) with no master password |
| Parameter group | `evomind-infrastructure-evominddbparametergroup-hzgsg1nxant9` (`rds.force_ssl`, connection logging) | Attached at restore |
| Security group / subnet group | `sg-05c00c014cd77e239` / `syssbnevomind` | Attached at restore |
| Backups | 7 days, window `05:39-06:09`, maintenance `thu:04:12-thu:04:42`, CA `rds-ca-rsa2048-g1` | Set at restore or immediately after |
| Stack | `EvoMindDB`, physical id `sysrdsevomind`, no `DeletionPolicy`; only the `RDSEndpoint` output references it; the stack has no service role, so CloudFormation runs as `BastionEC2Role` | The Lambdas read the endpoint from SSM, not from `!GetAtt` — removing the resource from the stack changes nothing at runtime |
| Key | AWS-managed `aws/rds` (decided Javear, 2026-11-02) | Free; no key policy to write |

### Why not set `StorageEncrypted: true` in the template

`StorageEncrypted` is a replacement property, and `EvoMindDB` has a custom `DBInstanceIdentifier`.
CloudFormation cannot replace a custom-named resource, so the deploy fails — and if it could, it
would create an **empty** instance. Swapping instances outside CloudFormation does not escape this
either: the stack tracks the identifier, so after the swap it already points at the encrypted
instance, but the moment the template says `StorageEncrypted: true` the next deploy reads a property
change and asks for a replacement again.

So the instance leaves the stack before the cut and is **imported** back after it, with a template
that describes it as it is. CloudFormation accepts an import into a template carrying the
`AWS::Serverless` transform from the CLI only (`CAPABILITY_AUTO_EXPAND`), not from the console.

---

## Phase 0 — Permissions (separate deploy, any day before the cut)

`BastionEC2Role` cannot snapshot, copy, restore, stop, or read drift today (all three probes refused
2026-11-02). IAM grants deploy in their own phase, never alongside the resource that needs them.

| Grant | Actions | Kept after the sprint? |
|---|---|---|
| Snapshot lifecycle | `rds:CreateDBSnapshot`, `rds:CopyDBSnapshot`, `rds:DescribeDBSnapshots`, `rds:DescribeDBInstanceAutomatedBackups`, `rds:DeleteDBSnapshot` | The two Describe actions kept; the rest removed at cleanup |
| Restore and retire | `rds:RestoreDBInstanceFromDBSnapshot`, `rds:StopDBInstance`, `rds:StartDBInstance`, `rds:DeleteDBInstance`, `rds:DeleteDBInstanceAutomatedBackup` | Removed at cleanup |
| The key, through RDS only | `kms:DescribeKey`, `kms:CreateGrant` on the `aws/rds` key, conditioned on `kms:ViaService: rds.us-east-2.amazonaws.com` | Removed at cleanup |
| Stack verification | `cloudformation:DescribeStackResource`, `cloudformation:DetectStackDrift`, `cloudformation:DetectStackResourceDrift`, `cloudformation:DescribeStackResourceDrifts`, `cloudformation:DescribeStackDriftDetectionStatus` | Kept — read-only |

Commit, `sam build && sam deploy --no-confirm-changeset`, then confirm with `aws rds describe-db-snapshots --db-instance-identifier sysrdsevomind --region us-east-2`.

---

## Phase 1 — Take the instance out of the stack (no downtime, any day before the cut)

**1.1 Retain.** Add to `EvoMindDB`, change nothing else, deploy:

```yaml
    DeletionPolicy: Retain
    UpdateReplacePolicy: Retain
```

These are stack metadata; CloudFormation makes no RDS call. They stay permanently — an import
requires them, and a database should never be deletable by a template edit.

**1.2 Remove.** Delete the `EvoMindDB` resource and the `RDSEndpoint` output from `template.yaml`;
deploy. The stack forgets the instance and leaves it running. Verify:

- `aws rds describe-db-instances --db-instance-identifier sysrdsevomind --region us-east-2 --query 'DBInstances[0].DBInstanceStatus'` → `available`
- `aws cloudformation describe-stack-resources --stack-name evomind-infrastructure --logical-resource-id EvoMindDB --region us-east-2` → not found
- A Slack round trip (`/ping` e2e) still succeeds.

The subnet group, parameter group and security group stay in the stack throughout.

---

## Phase 2 — The cut (quiet window, ~45–60 minutes)

Writes made to the old instance after the snapshot are not in the new one. Rather than rely on
nobody writing, the window **freezes writes**: a refused write is visible to whoever made it, a lost
one is silent.

### 2.0 Pre-flight

- Javear stays off Slack and Novia for the window; Slack and any scheduled run will error until §2.6.
- No run mid-execution: `PGC_WorkflowRun` rows with status `running` → none. A run **suspended at a
  gate** is safe — its state is in the snapshot — but its gate must not be answered until §2.6.
- Baseline row counts (§2.7's query) against the old instance, kept in the scratchpad.

### 2.1 Freeze writes

```bash
psql "$(aws ssm get-parameter --name /evolving-mind-ai/pgc-database-url --region us-east-2 --query Parameter.Value --output text)" -c "ALTER DATABASE evo_mind SET default_transaction_read_only = on"
```

The Lambdas open a connection per operation, so the next one is read-only. Confirm with a new
session: `SHOW default_transaction_read_only` → `on`. The setting travels in the snapshot.

### 2.2 Snapshot (unencrypted)

`aws rds create-db-snapshot --db-instance-identifier sysrdsevomind --db-snapshot-identifier sysrdsevomind-pre-encrypt-20261102 --region us-east-2`, then `aws rds wait db-snapshot-available --db-snapshot-identifier sysrdsevomind-pre-encrypt-20261102 --region us-east-2`.

### 2.3 Encrypted copy

`aws rds copy-db-snapshot --source-db-snapshot-identifier sysrdsevomind-pre-encrypt-20261102 --target-db-snapshot-identifier sysrdsevomind-encrypted-20261102 --kms-key-id alias/aws/rds --region us-east-2`, then wait as above. Confirm `Encrypted: true`.

### 2.4 Restore under a temporary name

`aws rds restore-db-instance-from-db-snapshot --db-instance-identifier sysrdsevomind-enc --db-snapshot-identifier sysrdsevomind-encrypted-20261102 --db-instance-class db.t4g.micro --availability-zone us-east-2a --no-multi-az --publicly-accessible --storage-type gp2 --db-subnet-group-name syssbnevomind --vpc-security-group-ids sg-05c00c014cd77e239 --db-parameter-group-name evomind-infrastructure-evominddbparametergroup-hzgsg1nxant9 --deletion-protection --auto-minor-version-upgrade --region us-east-2` (the bastion's CLI rejects `--ca-certificate-identifier` on a restore), then `aws rds wait db-instance-available --db-instance-identifier sysrdsevomind-enc --region us-east-2`.

Then check the CA, retention and windows against §0. On 2026-11-02 the restore carried all four over from the snapshot and no modify was needed; if any differs, `aws rds modify-db-instance --db-instance-identifier sysrdsevomind-enc` with the matching flags (`--ca-certificate-identifier`, `--backup-retention-period`, `--preferred-backup-window`, `--preferred-maintenance-window`) and `--apply-immediately`.

### 2.5 Verify before the swap — the abort point

Run §2.7's row-count query against `sysrdsevomind-enc` (the URL's host substituted inside the
command) and diff it with the baseline. **Any difference: stop.** Delete `sysrdsevomind-enc`, unfreeze
the old instance (§2.6's command against it), and nothing has changed.

Also confirm on the new instance: `StorageEncrypted: true`, a `KmsKeyId` is set (the copy named `alias/aws/rds` explicitly; don't call KMS directly — the bastion's grant is RDS-only, and the refusal prints the key id), the
parameter group is `in-sync`, `SELECT extname FROM pg_extension` lists `vector`.

### 2.6 Swap and unfreeze

1. `aws rds modify-db-instance --db-instance-identifier sysrdsevomind --new-db-instance-identifier sysrdsevomind-unenc --apply-immediately --region us-east-2`; poll `describe-db-instances` until `sysrdsevomind-unenc` is `available` — `aws rds wait` fails immediately while the old name is still `renaming`.
2. `aws rds modify-db-instance --db-instance-identifier sysrdsevomind-enc --new-db-instance-identifier sysrdsevomind --apply-immediately --region us-east-2`; poll until `sysrdsevomind` is `available` with `StorageEncrypted: true`.
3. Confirm the endpoint resolves to the new instance: `aws rds describe-db-instances --db-instance-identifier sysrdsevomind --region us-east-2 --query 'DBInstances[0].[Endpoint.Address,StorageEncrypted]'` → the unchanged hostname, `true`.
4. Confirm the SSM URL reaches the new instance — `select inet_server_addr()` through it differs from the address `sysrdsevomind-unenc` resolves to — so the unfreeze cannot land on the old one. Then unfreeze, in one session: `psql "$(…url…)" -c "SET default_transaction_read_only = off" -c "ALTER DATABASE evo_mind SET default_transaction_read_only = off"` — the `ALTER` alone is refused, because it runs in a read-only transaction. Confirm from a new session. **The old instance stays frozen.**
5. `aws rds stop-db-instance --db-instance-identifier sysrdsevomind-unenc --region us-east-2`.

Outage: from step 1 until step 3 resolves, ~5–10 minutes.

### 2.7 Row counts

Exact counts of every table, one command:

```bash
psql "$(aws ssm get-parameter --name /evolving-mind-ai/pgc-database-url --region us-east-2 --query Parameter.Value --output text)" -At -c "select table_name, (xpath('/row/c/text()', query_to_xml(format('select count(*) as c from %I.%I', table_schema, table_name), false, true, '')))[1]::text::bigint from information_schema.tables where table_schema='public' and table_type='BASE TABLE' order by 1"
```

### 2.8 Live check

`/ping` e2e from Slack, a read workflow, and one write Javear chooses — the first write on the new
instance, proving the unfreeze.

---

## Phase 3 — Import it back into the stack (same day)

**3.1 Template.** Restore `EvoMindDB` to `template.yaml` describing the instance as it is:

```yaml
  EvoMindDB:
    Type: AWS::RDS::DBInstance
    DeletionPolicy: Retain
    UpdateReplacePolicy: Retain
    Properties:
      Engine: postgres
      EngineVersion: "16"
      StorageEncrypted: true
      StorageType: gp2
      # … the existing properties, unchanged
```

`EngineVersion: "16"` names the major version only, so auto minor upgrades no longer leave the
template behind the instance. `KmsKeyId` is omitted — absent means the `aws/rds` key.

**3.2 Import.** An import change set may contain nothing but the import, so the template is the
**deployed** one plus the resource — not a fresh `sam package`, whose artifact URIs could differ:

1. `aws cloudformation get-template --stack-name evomind-infrastructure --template-stage Original --region us-east-2 --query TemplateBody --output text` → scratchpad file; add §3.1's block.
2. `aws cloudformation create-change-set --stack-name evomind-infrastructure --change-set-name import-encrypted-db --change-set-type IMPORT --resources-to-import '[{"ResourceType":"AWS::RDS::DBInstance","LogicalResourceId":"EvoMindDB","ResourceIdentifier":{"DBInstanceIdentifier":"sysrdsevomind"}}]' --template-body file://<scratchpad>/import.yaml --capabilities CAPABILITY_IAM CAPABILITY_AUTO_EXPAND --parameters ParameterKey=DBPassword,UsePreviousValue=true ParameterKey=YourKeyNameParameter,UsePreviousValue=true ParameterKey=SlackWebhookParam,UsePreviousValue=true ParameterKey=DBUser,UsePreviousValue=true ParameterKey=DBName,UsePreviousValue=true --region us-east-2`
3. `describe-change-set` shows one change, `Import` of `EvoMindDB`; then `execute-change-set`.

**3.3 Output.** Restore the `RDSEndpoint` output in `template.yaml`; `sam build && sam deploy --no-confirm-changeset`. The repo template now matches the stack.

**3.4 Drift.** `aws cloudformation detect-stack-resource-drift --stack-name evomind-infrastructure --logical-resource-id EvoMindDB --region us-east-2` → `IN_SYNC`. This is AC1's "template matches the live instance".

---

## Phase 4 — Cleanup (day 6, before RDS restarts the stopped instance on day 7)

F7 is closed only when **no unencrypted copy of the data remains**:

1. Disable deletion protection on `sysrdsevomind-unenc`, then `aws rds delete-db-instance --db-instance-identifier sysrdsevomind-unenc --skip-final-snapshot --delete-automated-backups --region us-east-2` — its automated backups are unencrypted too.
2. `aws rds delete-db-snapshot --db-snapshot-identifier sysrdsevomind-pre-encrypt-20261102 --region us-east-2`.
3. Confirm `describe-db-snapshots` and `describe-db-instance-automated-backups` list nothing unencrypted — **across the account, not filtered by instance**: CloudFormation leaves `evomind-infrastructure-snapshot-evominddb-*` snapshots of instances it replaced, which an `--db-instance-identifier` filter misses (two from 2026-03-05 were found and deleted this way). The deleted instance's automated snapshots stay listed `available` for a few minutes after the retained-backup record is gone; they cannot be deleted by hand — poll until they clear.
4. Keep `sysrdsevomind-encrypted-20261102` for a month as a known-good baseline.
5. Remove Phase 0's write grants; keep the read ones. Separate deploy. **IAM takes a little while to propagate — never probe a removed write grant with a real write**: on 2026-11-02 the first probe succeeded and left an encrypted snapshot, `grant-probe`, for the console to delete. Probe with a call that cannot succeed anyway, or wait.

---

## Rollback

| Point reached | Rollback |
|---|---|
| Before §2.6 | Delete `sysrdsevomind-enc`; unfreeze the old instance. Nothing else changed |
| After §2.6, before Phase 3 | Rename `sysrdsevomind` → `sysrdsevomind-enc`, start `sysrdsevomind-unenc` and rename it back to `sysrdsevomind`, unfreeze it. Writes made on the new instance since the swap are lost — so decide within the live check, not days later |
| After Phase 3 | The encrypted instance is the stack's; go forward, not back |
| Phase 1, at any time | Re-import the unencrypted `sysrdsevomind` with §3.2 and the old properties |
