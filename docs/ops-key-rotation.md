# Key Rotation Runbook

Operational procedure for rotating every credential in the system. Written 2026-09-06, ahead of
the system holding real household data.

**This document never contains a secret value, and no step in it requires one to be typed into a
transcript, a commit, or a shell history file.** Where a value must be entered, the step uses a
prompt-and-capture form that keeps it out of history.

---

## 0. The credential inventory

Six SSM parameters, five distinct secrets — `llm-api-key` serves both the LLM and the embedding
client.

| SSM parameter (`/evolving-mind-ai/…`) | Protects | Issued by | Consumers |
|---|---|---|---|
| `pgc-database-url` | Postgres connection string, PGC — embeds the `lambda_user` password | You, via RDS | SERV Lambda, `dev_scripts`, integration tests |
| `pgd-database-url` | Postgres connection string, PGD | You, via RDS | SERV Lambda |
| `internal-api-key` | PROC↔SERV shared secret **and** the API Gateway key value | Self-generated | All four Lambdas, API Gateway, `dev_scripts`, curl |
| `llm-api-key` | Perplexity — `LLM_API_KEY` and `EMBEDDING_API_KEY` | Perplexity dashboard | PROC, SERV |
| `slack-bot-token` | Slack bot token | Slack app admin | slackbot, proc, callback listener |
| `slack-signing-secret` | Slack request signature verification | Slack app admin | slackbot only |

### Credentials that are not in SSM and are easy to forget

- **The bastion EC2 SSH keypair** — grants shell on a host whose role can already read SSM.
- **IAM access keys** for CLI use, if any exist.
- **`.env.test`** — the on-disk copy of `INTERNAL_API_KEY`, `PGC_DATABASE_URL` **and
  `LLM_API_KEY`** (line 18, read by `tests/integration/llm-prompt-schema.test.mjs`). Three secrets,
  not two — corrected 2026-09-06 during the Perplexity rotation, having been listed as two.
  `~/.bashrc` line 42 does `set -a; source ~/evolving-ai-mind/.env.test; set +a`, so this one file
  supplies the shell, every `dev_scripts` run, and the integration tests. Untracked, and confirmed
  never committed.
- **`.claude/settings.local.json`** — carries the live `INTERNAL_API_KEY` inline in three Bash
  permission patterns. Untracked and covered by `~/.config/git/ignore`, so it never reached
  GitHub, but it is a cleartext copy on disk. See §6.

### Standing exposure notes

- SSM parameters are `String`, not `SecureString` — architectural and final. The consequence to
  hold in mind is that `ssm:GetParameter` reads all six in plaintext, and because
  `{{resolve:ssm:…}}` bakes values into Lambda environment variables,
  `lambda:GetFunctionConfiguration` does too. **IAM reach is the real control on these secrets**,
  which is why the SSH keypair and IAM access keys above are part of this inventory and not an
  afterthought.
- RDS is `PubliclyAccessible: true` with app user `lambda_user` — also architectural and final.
  The password is therefore the only thing between the open internet and real data, gated solely
  by the security group. **Verify the security group before trusting any password.** See §1.

---

## 1. Pre-flight

Do these before changing any value.

1. **Confirm the RDS security group does not allow `0.0.0.0/0` on 5432.**
   Security group `sg-05c00c014cd77e239`, region `us-east-2`. The bastion role is denied
   `ec2:DescribeSecurityGroups`, so this is a console check. Ingress should be the Lambda egress
   range and the bastion only. A fresh password behind an open security group is worth less than
   an old password behind a tight one.

2. **Confirm no workflow runs are in flight.** Rotation of `internal-api-key` and of the database
   password both have a window where in-flight calls fail. SQS retries cover the async paths, but
   a suspended `human_gate` waiting on a user is better resumed or abandoned first.

3. **Confirm both database URLs use the same role.** If `pgc-database-url` and `pgd-database-url`
   embed different users, §3 changes from one `ALTER USER` to two.

4. **Shell history hygiene — set this up once, now.** Every command below that takes a value uses
   `read -rs`, so the value lands in a shell variable and never in `~/.bash_history`. Do not
   substitute an inline `--value <secret>` form; that is written to history verbatim.

---

## 2. `internal-api-key`

The most involved rotation, because one value lives in two places that must agree: the API Gateway
key that guards `/proc/*` and `/serv/*`, and the `INTERNAL_API_KEY` env var the Lambdas send to
each other.

### 2.1 The silent-failure risk, and why the template gets pinned

`template.yaml` currently references the parameter **unpinned**:

```yaml
Value: '{{resolve:ssm:/evolving-mind-ai/internal-api-key}}'
```

An unpinned dynamic reference resolves at deploy time. The hazard is that if the template text and
the Lambda code are both unchanged, `sam deploy` can compute an empty changeset and never
re-resolve — leaving the old key live in API Gateway and in every Lambda environment while SSM
holds the new one. You would believe you had rotated, and the old key would still work.

**Pin the version instead.** Changing the pin changes the template text, which guarantees a
changeset and a re-resolve, and makes the deployed version auditable in `git diff`:

```yaml
Value: '{{resolve:ssm:/evolving-mind-ai/internal-api-key:2}}'
```

This adds one template edit per rotation. That is the cost of removing the question entirely.
Pinning is orthogonal to the `String`-not-`SecureString` decision and does not touch it.

The verification in §2.5 catches this failure mode whether or not you pin — but pinning means you
do not have to rely on catching it.

### 2.2 Generate and store

**Run this from an admin session on your PC, not on the bastion.** `BastionEC2Role` is granted
`ssm:GetParameter` but denied `ssm:PutParameter`, and that asymmetry is deliberate — the bastion is
an internet-facing host that already holds plaintext copies of two secrets. Do not widen the role
to make a rotation convenient; the read-only property is worth more than the convenience.

The split costs nothing, because the bastion can still *read*. The value is written from your PC
and pulled down from SSM in §2.4 — it never needs to be carried between machines by hand.

```bash
read -rs NEWKEY            # paste or generate; nothing echoes, nothing enters history
aws ssm put-parameter --name /evolving-mind-ai/internal-api-key --value "$NEWKEY" --type String --overwrite --region us-east-2
```

`--overwrite` creates a new version. Note the version number it returns — that is the pin value.

To generate rather than paste: `NEWKEY=$(openssl rand -hex 32)` in place of the `read`.

**PowerShell equivalent**, since the admin session in §2.2 is on Windows. Use the .NET crypto RNG —
`Get-Random` is not cryptographically secure and must not generate a key:

```powershell
$bytes = [byte[]]::new(32)
[System.Security.Cryptography.RandomNumberGenerator]::Create().GetBytes($bytes)
$NEWKEY = [System.BitConverter]::ToString($bytes).Replace('-','').ToLower()

aws ssm put-parameter --name /evolving-mind-ai/internal-api-key --value $NEWKEY --type String --overwrite --region us-east-2

Remove-Variable NEWKEY
```

Works on PowerShell 5.1 and 7. `$NEWKEY.Length` prints 64 without revealing the value.

**The variable is load-bearing here.** PSReadLine persists console history to disk automatically
(`(Get-PSReadLineOption).HistorySavePath`), across sessions and without prompting. Holding the key
in `$NEWKEY` keeps the literal out of that file; pasting it inline as `--value <secret>` writes it
there permanently and the file then has to be scrubbed.

**Format constraint — this value is also an API Gateway key.** It must be 20–128 characters and
must not contain whitespace. A hex or base62 string is safe; a passphrase with spaces or symbols
can be accepted by SSM and then rejected at deploy, which fails the stack update partway through.
`openssl rand -hex 32` satisfies this by construction.

### 2.3 Pin and deploy

Update **all** `internal-api-key` references in `template.yaml` to the new version — there are
four: lines 600, 648, 698, and the `InternalApiKey` resource at 767.

**The `InternalApiKey` resource must not carry an explicit `Name`.** Changing `Value` forces
resource replacement, and CloudFormation creates the replacement *before* deleting the original.
API Gateway rejects the second key, the stack rolls back, and the rotation fails:

```
UPDATE_FAILED  InternalApiKey  "ApiKey with name evolving-mind-ai-internal-key already exists"
                               (HandlerErrorCode: AlreadyExists)
```

Observed on 2026-09-06 and fixed by removing the property. The rollback is clean — Lambdas revert
to the prior version and the original key survives — so this fails safe, but it fails. Nothing
depends on the name: `InternalApiUsagePlanKey` binds by `!Ref`.

```bash
sam build && sam deploy --no-confirm-changeset
```

Confirm the changeset actually lists `InternalApiKey` and the four functions. An empty changeset
here means the rotation did not deploy.

### 2.4 Update the on-disk copies

Three places, and they must move together:

1. **`.env.test`** — `INTERNAL_API_KEY`. This alone fixes the shell, `dev_scripts`, and the
   integration tests. Pull the value from SSM rather than retyping it — the bastion has read
   access, so the new value never has to be carried from the machine that set it:

   ```bash
   NEWKEY=$(aws ssm get-parameter --name /evolving-mind-ai/internal-api-key --query Parameter.Value --output text --region us-east-2)
   sed -i "s|^INTERNAL_API_KEY=.*|INTERNAL_API_KEY=$NEWKEY|" ~/evolving-ai-mind/.env.test
   unset NEWKEY
   ```

   The value is briefly visible in `ps` to other users during the `sed`; acceptable on a
   single-account host, and avoidable with `sed -i -f` reading from a mode-600 script file if that
   ever stops being true.
2. **`.claude/settings.local.json`** — three permission patterns at lines 31, 33, 34 embed the old
   value literally. See §6 for the durable fix; at minimum they need the new value or those
   commands start prompting.
3. **The running session.** `.bashrc` sources `.env.test` at login, so an already-running shell —
   including the tmux session and the Claude Code process inside it — holds the **old** value in
   memory. Restart the tmux session after editing, or every curl fails with a stale key and a
   confusing 403.

### 2.5 Verify

Old key must be rejected, new key must be accepted. Check status only — never print a body that
might echo a key:

```bash
curl -s -o /dev/null -w '%{http_code}\n' -X POST "$SERV_API_URL/api/v1/serv/schema/listPhysicalTables" -H "Content-Type: application/json" -H "x-api-key: $INTERNAL_API_KEY" -d '{}'
```

Expect `200` with the new key in the environment. Then repeat with the old value in a
`read -rs OLDKEY` variable and expect `403`. **If the old key still returns 200, the deploy did not
re-resolve** — that is the §2.1 failure, and the fix is to pin and redeploy.

### 2.6 Rollback

SSM keeps prior versions. Re-pin the template to the previous version and redeploy; no value needs
to be retyped.

---

## 3. Database password

**Both URL parameters hold the identical value** — same user, same host, same database
(`lambda_user @ …/evo_mind`). PGC and PGD are one database separated by table prefix, not by
credentials, so this is **one password change and two SSM writes that must not drift**. If they
diverge, one Lambda authenticates and the other does not, which presents as an intermittent fault
rather than a clean failure. `lambda_user` is also the RDS master user, so it can change its own
password with no separate admin credential.

**There is no separate password parameter, and none should be created.** Nothing reads a bare
password — `src/` reads `PGC_DATABASE_URL` and `PGD_DATABASE_URL` as complete connection strings.
A `/evolving-mind-ai/lambda-user-pw` parameter would be an orphan: a third plaintext copy of the
secret with no consumer.

The exact URL shape, confirmed 2026-09-06 — note `postgresql://`, not `postgres://`, and no query
suffix:

```
postgresql://lambda_user:<PW>@sysrdsevomind.cx8eoo8eaw8h.us-east-2.rds.amazonaws.com:5432/evo_mind
```

### 3.1 Generate a password that cannot corrupt the URL

The values are connection **URLs**. A password containing `@ : / # ? %` or a space corrupts the URL
and produces errors that look like authentication failures — the most common way this rotation goes
wrong.

**Generate hex and the problem cannot occur.** Hex is alphanumeric by construction and URL-safe by
definition, so no encoding step is needed and none can be forgotten. 24 bytes → 48 characters:

```powershell
$bytes = [byte[]]::new(24)
[System.Security.Cryptography.RandomNumberGenerator]::Create().GetBytes($bytes)
$PW = [System.BitConverter]::ToString($bytes).Replace('-','').ToLower()
```

### 3.2 Write both parameters

```powershell
$URL = "postgresql://lambda_user:${PW}@sysrdsevomind.cx8eoo8eaw8h.us-east-2.rds.amazonaws.com:5432/evo_mind"

$URL.Length                                                            # expect 142
$URL -match '^postgresql://lambda_user:[0-9a-f]{48}@sysrdsevomind\.'   # expect True

aws ssm put-parameter --name /evolving-mind-ai/pgc-database-url --value $URL --type String --overwrite --region us-east-2
aws ssm put-parameter --name /evolving-mind-ai/pgd-database-url --value $URL --type String --overwrite --region us-east-2
```

Use `${PW}` with braces. Both parameters take the identical `$URL` from the same variable in the
same session — that is the guard against drift. Verify both checks pass **before** either write.

Nothing breaks at this point: SSM holds versions that nothing reads yet.

### 3.3 Deploy BEFORE changing the password

**This ordering is the opposite of the obvious one, and it is deliberate.**

- **Password first:** if the deploy then fails and rolls back, the Lambdas revert to the *old* URL
  while the database has the *new* password. The outage persists until you diagnose and redeploy.
- **Deploy first:** if it fails, nothing is harmed — the password is untouched and the system keeps
  running on the old one. Retry costs nothing.

Deploy-first puts the fragile step where its failure is free. The stack rollback observed in §2.3 is
why this is not hypothetical.

Pin both parameters in `template.yaml` (lines 694, 695). **They will be at different version
numbers** — easy to transpose. Then:

```bash
sam build && sam deploy --no-confirm-changeset
```

Before deploying, open `psql "$PGC_DATABASE_URL"` in a separate pane and leave it at the prompt. It
authenticates with the current password, so it survives the change and is your escape hatch if the
new value does not take.

**If the deploy fails and rolls back, do not change the password.** Retry the deploy.

### 3.4 Change the password, immediately

The moment the deploy reports success the outage begins — the Lambdas hold a password the database
does not have. In the waiting session:

```
\password lambda_user
```

Prompts twice, echoes nothing, sends a pre-hashed value, and leaves no plaintext in
`~/.psql_history`. A literal `ALTER USER lambda_user WITH PASSWORD '…'` writes the secret to that
file in cleartext — do not use it.

The outage is the gap between deploy completion and this command: seconds, if you are at the
keyboard. Pooled connections opened before the change survive until recycled.

### 3.5 Verify

Only `ServFunction` holds the database URLs, so one read proves the whole surface. A deploy replaces
the function configuration and invalidates warm containers, so this is genuinely a new connection
rather than a surviving pooled one:

```bash
K=$(aws ssm get-parameter --name /evolving-mind-ai/internal-api-key --query Parameter.Value --output text --region us-east-2)
curl -s -X POST "$SERV_API_URL/api/v1/serv/schema/listPhysicalTables" -H "Content-Type: application/json" -H "x-api-key: $K" -d '{}'
unset K
```

Then update `PGC_DATABASE_URL` in `.env.test` and restart the shell.

## 4. Slack — bot token and signing secret

Both are rotated in the Slack app admin, not by us.

- **Bot token.** Regenerating invalidates the old token immediately, so the gap between
  regeneration and a completed deploy is a hard outage for all Slack interaction. Have the
  `put-parameter` and `sam deploy` ready to run before you click regenerate.
- **Signing secret.** Slack supports a rotation with an overlap window during which both the old
  and new secret verify. Use it — it makes this the one rotation here that need not be rushed.

Store each with the `read -rs` form from §2.2, pin `template.yaml` (bot token at 597, 647, 733;
signing secret at 598), and deploy.

**Verify** by sending a `/mind` command from Slack. A bad signing secret produces a signature
rejection at `handler.mjs`; a bad bot token produces a workflow that runs but posts nothing back.
The two fail differently, which tells you which one is wrong.

**Deferred by decision, 2026-09-06.** Neither Slack secret was exposed, so both were assessed and
skipped rather than overlooked. They remain at their original values and are the two oldest
credentials in the inventory — rotate them on the next scheduled pass, or immediately if the Slack
app's admin membership changes.

---

## 5. Perplexity

The only rotation that is naturally zero-downtime, because Perplexity permits multiple live keys.

**That property is also what makes it the hardest one to verify**, and the point is easy to miss.
Every other rotation invalidates the old value, so a working system proves the new value deployed.
Here both keys are live at once: a green probe after the deploy proves only that *some* valid key is
in the environment, not that it is the new one. A silent partial rotation — SSM holding v5 while the
Lambdas still run v4 — looks exactly like success. §5.3 is the step that distinguishes them.

1. Create the new key in the dashboard. **Do not delete the old one yet.**
2. `put-parameter` into `llm-api-key`. Note the version it returns.
3. Pin `template.yaml` — **lines 644 and 697**, one parameter feeding two env vars, `LLM_API_KEY`
   on ProcFunction and `EMBEDDING_API_KEY` on ServFunction. Then `sam build && sam deploy
   --no-confirm-changeset`.
4. Verify — §5.2 and §5.3, both.
5. Update `.env.test` line 18 — §5.4.
6. **Then** delete the old key in the dashboard.

The last step is the one that gets skipped. An undeleted old key is an un-rotated key.

### 5.1 Baseline first

Run both probes in §5.2 **before** deploying. A failure afterwards is only diagnostic if you know
the path worked beforehand.

### 5.2 The two functional probes — neither needs a workflow or Slack

Both halves have a direct endpoint. Nothing here writes, and nothing costs more than one small
completion and one embedding.

**LLM half** — `ping-llm` validates ProcFunction plus the provider, with no Slack, SQS or DB call:

```bash
curl -s -X POST "$PROC_API_URL/api/v1/proc/ping-llm" -H "Content-Type: application/json" -H "x-api-key: $INTERNAL_API_KEY" -d '{}'
```

Expect `success: true` and a `model` of `sonar`.

**Embedding half** — a `vectorSearch` descriptor makes SERV embed the query text, which is the only
thing on that path using `EMBEDDING_API_KEY`. Read-only:

```bash
curl -s -X POST "$SERV_API_URL/api/v1/serv/table/getRows" -H "Content-Type: application/json" -H "x-api-key: $INTERNAL_API_KEY" -d '{ "tableName": "PGC_DomainHelp", "vectorSearch": { "column": "embedding", "queryText": "grocery shopping receipt", "threshold": 0.2 }, "columns": ["id", "domain"], "limit": 3 }'
```

Expect a row with a real `similarity`. **Compare the similarity value to the baseline** — an
identical score is evidence the same embedding model returned the same vector, where a merely
non-empty response is not.

### 5.3 Prove the new key actually deployed

The probes above cannot do this, for the reason in the section opener. Compare a hash of the
deployed Lambda environment against a hash of each SSM version. **Hashes, never values** — this
prints nothing secret, and the old version's hash is what gives the comparison meaning:

```bash
P=$(aws lambda get-function-configuration --function-name evolving-mind-ai-proc --region us-east-2 --query 'Environment.Variables.LLM_API_KEY' --output text)
S=$(aws lambda get-function-configuration --function-name evolving-mind-ai-serv --region us-east-2 --query 'Environment.Variables.EMBEDDING_API_KEY' --output text)
NEW=$(aws ssm get-parameter --name "/evolving-mind-ai/llm-api-key:5" --query Parameter.Value --output text --region us-east-2)
OLD=$(aws ssm get-parameter --name "/evolving-mind-ai/llm-api-key:4" --query Parameter.Value --output text --region us-east-2)
h(){ printf '%s' "$1" | sha256sum | cut -c1-12; }
echo "proc $(h "$P")"; echo "serv $(h "$S")"; echo "new  $(h "$NEW")"; echo "old  $(h "$OLD")"
unset P S NEW OLD
```

Both Lambda hashes must equal the new version's and differ from the old one's. If they match the
old, the deploy did not re-resolve — that is the §2.1 failure, and the fix is to check the pin and
redeploy.

**This check is not Perplexity-specific.** It is the direct form of what §2.5 tests indirectly
through a 403, it works for every parameter in the inventory, and it is the only form available
when the old credential is still valid. Substituting the version numbers is the whole change.

### 5.4 The on-disk copy

`.env.test` line 18 holds `LLM_API_KEY` for the integration tests. Pull it from SSM rather than
retyping, and keep the value out of `argv` — `sed -i "s|…|$KEY|"` puts it in the process
arguments, visible in `ps`:

```bash
export NEWKEY=$(aws ssm get-parameter --name "/evolving-mind-ai/llm-api-key:5" --query Parameter.Value --output text --region us-east-2)
node -e "const fs=require('fs');const p=process.env.HOME+'/evolving-ai-mind/.env.test';const t=fs.readFileSync(p,'utf8');const o=t.replace(/^LLM_API_KEY=.*$/m,'LLM_API_KEY='+process.env.NEWKEY);if(o===t){console.log('NO CHANGE — pattern did not match');}else{fs.writeFileSync(p,o,{mode:0o600});console.log('updated');}"
grep -q "^LLM_API_KEY=$NEWKEY$" ~/evolving-ai-mind/.env.test && echo 'matches SSM' || echo 'MISMATCH'
unset NEWKEY
```

The rewrite reports `NO CHANGE` rather than succeeding silently if the pattern misses — a silent
no-op here leaves the tests on a key that is about to be deleted.

A shell that was already running still holds the old value in memory; `.bashrc` sources `.env.test`
at login only. Restart the shell before running the integration tests.

---

## 6. Post-rotation sweep

1. **Remove the literal key from `.claude/settings.local.json` permanently.** The three patterns at
   lines 31, 33, 34 embed the value because the commands were written with the key inline. Rewriting
   those commands to reference `$INTERNAL_API_KEY` — which `.bashrc` already exports via `.env.test`
   — lets the permission pattern match the literal text `$INTERNAL_API_KEY` while the shell expands
   the real value at runtime. The pattern keeps working, the file stops holding a secret, and it
   survives every future rotation without edits. Worth doing once, during this rotation.

2. **Keep the on-disk copies at mode `600`.** `.env.test` and `.claude/settings.local.json` were
   both found at `644` on 2026-09-06 and tightened. Editors and generated files can quietly restore
   a permissive mode, so re-check after any rotation that rewrites them:

   ```bash
   stat -c '%a %n' ~/evolving-ai-mind/.env.test ~/evolving-ai-mind/.claude/settings.local.json
   ```

3. **Delete the stray `.claude/setting.json`** (singular — a typo file next to the real
   `settings.json`). It holds no secret, but a misnamed config file is a place for one to hide.

4. **Confirm nothing holds an old value:**

```bash
grep -rl "INTERNAL_API_KEY=" ~/evolving-ai-mind/.claude/ ~/evolving-ai-mind/.env.test 2>/dev/null
```

Then check each hit is the new value. Do not print them — compare with a `grep -q` against a
`read -rs` variable.

5. **Confirm no secret entered git.** Verified clean on 2026-09-06 and worth re-running after any
   rotation that touched a tracked file:

```bash
git grep -lIE "xoxb-|pplx-[A-Za-z0-9]{20,}|postgres://[^ ]*:[^ @]*@" -- .
```

Doc placeholders (`xoxb-...`) and the embedding **model name** (`pplx-embedding-…`) both match
loosely — the `{20,}` bound above separates a real Perplexity key from the model name.

6. **Rotate the bastion SSH keypair and any IAM access keys**, if they have never been rotated.
   These grant a path to the same data and are not covered by anything above.

---

## 7. Order of operations

Sequenced so that each rotation's outage window is short and independent:

| # | Step | Who | Downtime |
|---|---|---|---|
| 1 | Security group check, in-flight run check | You (console) | None |
| 2 | `internal-api-key` | You + deploy | Seconds, during deploy |
| 3 | Database password | You (psql) + deploy | Minutes — see §3.4 |
| 4 | Slack signing secret | You (Slack admin) | None, if the overlap window is used |
| 5 | Slack bot token | You (Slack admin) | Until deploy completes |
| 6 | Perplexity key | You (dashboard) | None, if created before deleting |
| 7 | Sweep — §6 | You | None |

Steps 2 and 3 both end in a deploy. They can be combined into a single `sam deploy` if you prefer
one window to two: put both parameters, pin all references, deploy once, verify both.
