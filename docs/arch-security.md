# Security Architecture — evolving-mind-ai
<!-- Copyright (c) 2026 Javea Guiri. All rights reserved. -->

> Part of the evolving-mind-ai architecture docs. Main overview: `docs/architecture.md`.

## 1. Threat Model

evolving-mind-ai is a household-scale private deployment. The attack surfaces are:

- **Slack endpoints** — publicly reachable API Gateway URLs. Anyone who knows the URL
  can POST to them without authentication unless protected.
- **PROC endpoints** — business logic layer. A fake request can trigger LLM calls,
  DDL execution, or workflow cancellation.
- **SERV endpoints** — data layer. A fake request can read or write PGC/PGD tables.
- **Prompt injection** — malicious content in user input or LLM output attempting to
  manipulate workflow execution. The right-brain validation loop checks output **shape**; it does
  not stop an injected instruction from being followed. §6 covers the agent threats.
- **The database** — publicly reachable on 5432 (`RDSSecurityGroup`, `0.0.0.0/0`), protected by
  password and forced TLS (`rds.force_ssl`).
- **The bastion** — SSH ingress `0.0.0.0/0` (`template.yaml`, marked TODO).
- **The web site** (Sprint 14, `docs/arch-web-app.md`) — a public page holding a user's tokens and
  rendering LLM-written markdown.

**Reference frameworks** this model is checked against: OWASP Top 10 for LLM Applications (2025),
OWASP Top 10 for Agentic Applications, OWASP API Security Top 10 (2023), MITRE ATLAS.

**Governing principle for every LLM-driven path:** authorisation never depends on the model
behaving. An agent acts **on behalf of a principal**, and that principal's rights are enforced
below it — in SERV and in the database — so an injected instruction reaches at most what the
principal could already reach.

## 2. Slack Endpoint Security — Signing Secret Verification

**All `/api/v1/ui/slack/*` routes verify the Slack signing secret before any routing
or business logic executes.** This includes `/mind`, `/chat`, and `/explain`.

Every genuine Slack request includes two headers:
- `X-Slack-Signature` — HMAC-SHA256 of `"v0:{timestamp}:{raw_body}"` signed with the signing secret
- `X-Slack-Request-Timestamp` — Unix timestamp of when Slack sent the request

The handler computes the expected signature independently and compares using
`timingSafeEqual` (Node.js `crypto`) — constant-time comparison that prevents
timing attacks. Requests older than 5 minutes are rejected regardless of signature.

**Implementation:** `src/ui/slackbot/handler.mjs` — `verifySlackSignature()`

```js
const sigBase  = `v0:${timestamp}:${rawBody}`;
const expected = 'v0=' + createHmac('sha256', signingSecret)
                           .update(sigBase, 'utf8')
                           .digest('hex');

if (!timingSafeEqual(Buffer.from(signature), Buffer.from(expected))) {
  return err(401, 'Unauthorized — invalid Slack signature');
}
```

**Exempt routes:** `EXEMPT_ROUTES = new Set(['ping'])` — health check only.
All command routes (`mind`, `chat`, `explain`, `create-domain`, etc.) are verified.

**SSM parameter:** `/evolving-mind-ai/slack-signing-secret` — `String`.

## 3. PROC and SERV Endpoint Security — API Gateway API Key

`/proc/*` and `/serv/*` are protected by an AWS API Gateway API key enforced natively
at the gateway level — Lambda is never invoked for requests with a missing or invalid key.

**Mechanism:** `x-api-key` header checked by API Gateway before routing.

- `AWS::ApiGateway::ApiKey` — the key resource, value sourced from SSM
- `AWS::ApiGateway::UsagePlan` — associates the key with the Prod stage
- `Auth: ApiKeyRequired: true` — set on ProcProxy and ServProxy SAM events

**PROC → SERV calls:** The PROC Lambda passes the key automatically via
`INTERNAL_API_KEY` env var (resolved from SSM). `serv-client.mjs` injects
`x-api-key` into every outgoing fetch to SERV.

**Exempt routes on SERV:** `ping-db` is exempt — health check used by external
monitoring and not a sensitive operation.

**SSM parameter:** `/evolving-mind-ai/internal-api-key` — `String`.

**curl usage:** All PROC and SERV curl commands require `-H "x-api-key: <key>"`.
The key is stored in `.env.test` (not committed) for local dev convenience.

## 4. Security Implementation Status

| Surface | Protection | Status |
|---|---|---|
| `/ui/slack/*` (all commands) | Slack signing secret — HMAC-SHA256 + replay protection | ✅ Implemented |
| `/proc/*` | API Gateway API key — checked before Lambda invocation | ✅ Implemented |
| `/serv/*` | API Gateway API key — same key, checked before Lambda invocation | ✅ Implemented |
| `/serv/ping-db` | No key required — read-only health check | ✅ Intentionally exempt |
| Prompt injection | Right-brain validation loop — Ajv + AST gate (output shape only) | 🟡 Partial — §6 |

## 5. What Is Deliberately Not Done

- **No VPC on Lambda** — cost decision ($32/month NAT Gateway avoided). Final — do not suggest VPC.
- **No WAF** — AWS WAF adds ~$5-10/month minimum. Not justified at this scale.
- **No API keys on Slack endpoints** — Slack signing secret is the correct mechanism.
- **No SigV4 signing on PROC→SERV calls** — API key in env var achieves equivalent
  protection without requiring AWS SDK credential management in serv-client.mjs.
- **No separate key per caller** — single internal key for this household deployment.
  Rotate via SSM parameter update + redeploy if compromised. **Under review (2026-10-22):** a
  second caller (`WebApiFunction`) arrives with Sprint 14, and one key opens every SERV endpoint,
  DDL included — see §7 and `docs/backlog.md`.

---

## 6. Agent threats — Novia and every `llm_call`

| Threat | Framework | Where it enters | Control today | Gap |
|---|---|---|---|---|
| **Direct prompt injection** | LLM01 | A `/novia` or `/mind` message | Human gate on every Novia write; exact gate diff (Sprint 11) | The gate is the only control — an injection's best route is a harmful change that reads as harmless |
| **Indirect prompt injection** | LLM01 | Domain data read into a prompt — receipt text, record titles, memory rows, tool results | None beyond the model | Data reaches every `llm_call`, not only Novia |
| **Excessive agency** | LLM06 | `register_workflow` creates code that runs (`js_transform`, conditions) | Human gate; L0/L1/L2 simulation | Template conditions run without an AST gate (§8, F1) |
| **Sensitive data disclosure** | LLM02 | `run_sql`, `query_table` | Read-only regex on `runSql` | Reads every PGC and PGD table under one database login (§8, F2) |
| **Memory poisoning** | LLM04, agentic | `PGC_Memory` rows written by Novia or `save_to_memory` | Provenance columns exist (`source_run_id`, `source_workflow`) | An injected memory is replayed into later sessions; nothing distinguishes memory derived from untrusted content |
| **Exfiltration** | LLM02, LLM05 | Rendered markdown (a remote image URL carrying data), link unfurls, code with network access | Not verified for Slack's `markdown` block | The web site renders no remote images (`arch-web-app.md` §11); Slack's image and unfurl behaviour to be checked; an escaped sandbox has `fetch` |
| **Unbounded consumption** | LLM10, API4 | Injected loops, `pg_sleep`, large reads | Novia turn and action limits; 1000-row read cap; step-count guards | `runSql` has no statement timeout |

**The design rule for Novia.** She runs as the session's principal. Her tools call SERV carrying
that principal, and SERV and the database enforce it (§7). A prompt rule telling her not to read
something is not a control.

---

## 7. SERV hardening — the target design

SERV is the only path to data (`arch-home-brain.md` §3.3), so it is the one place to enforce.
Each item is a backlog row in `docs/backlog.md`.

| # | Control | What it closes |
|---|---|---|
| **S1** | **Database roles by job** — a read-only role for `runSql`, a data role for DML, a DDL role for the schema endpoints; the master user for bootstrap and migrations only | A misused endpoint is bounded by its role, not by SERV's code |
| **S2** | **`runSql` in `BEGIN READ ONLY`** under the read-only role, with `statement_timeout`; the regex stays as an early refusal | Functions the denylist misses — `pg_sleep`, `pg_terminate_backend`, `set_config`, `SELECT … FOR UPDATE` |
| **S3** | **IAM database authentication** for the Lambda role — short-lived tokens instead of a static password | The public 5432 port no longer guards a reusable secret. Compatible with the final no-VPC, publicly-accessible decision |
| **S4** | **A key per caller** — PROC, `WebApiFunction`, developer tooling — with DDL and `runSql` accepting only the callers that need them | One leaked key opening every endpoint |
| **S5** | **The principal carried to SERV** — `{ user, roles }` on every request; a header while there is one user, a signed short-lived token once there are several | Novia, or compromised PROC code, acting beyond the user it serves |
| **S6** | **Row-level security** on tables whose rows belong to a user or role, set per transaction from S5 | Object-level authorisation (API1, API3) enforced by the database even when code forgets a filter |

---

## 8. Findings register (2026-10-22)

| # | Finding | Evidence | Severity | Backlog |
|---|---|---|---|---|
| **F1** | Template expressions and conditions run in `vm.runInNewContext` with no AST gate, over a context object created in the host realm. Node documents `vm` as not a security boundary, and a host-realm context is what the standard escape uses to reach `process` — PROC's environment holds the internal API key and the LLM key. **Unverified** — a local probe confirms or clears it | `template-resolver.mjs:153`, `:197`. `js_transform` is gated and passes data as JSON strings (`step-executor.mjs:221`) | High if confirmed | Yes |
| **F2** | `runSql` is guarded by a regex alone, runs under SERV's one login with no read-only transaction or timeout, and reads every table | `schema.mjs:189-190`, `table.mjs` `runSql` | High | Yes (S1, S2) |
| **F3** | The database accepts connections from any address; the password is the only barrier | `template.yaml` `RDSSecurityGroup` ingress `0.0.0.0/0` | Medium | Yes (S3) |
| **F4** | Bastion SSH open to any address | `template.yaml` `BastionSecurityGroup`, marked TODO | Medium | Yes |
| **F5** | One internal key for every PROC and SERV caller | §3 | Medium | Yes (S4) |
| **F6** | Memory written from untrusted content is replayed into later prompts | §6 | Medium | Yes |
| **F7** | Encryption at rest absent | `EvoMindDB` has no `StorageEncrypted` | Medium | **Sprint 14, AC6** |
| **F8** | Secrets in logs | `docs/ops-release-readiness.md` R4 | Low | R4 |

**Accepted by final decision:** secrets are SSM `String` parameters resolved into Lambda
environment variables, and the Lambdas run outside a VPC against a publicly accessible database.
F1 matters more because of the first.

---

## 9. The web site

`docs/arch-web-app.md` §11 holds the site's own controls: Cognito tokens and the authorizer, no
internal key in the browser, a strict Content Security Policy, markdown without raw HTML or remote
images, and a pinned, audited dependency tree.

---

## 10. Multi-tenancy (direction)

`arch-home-brain.md` §5 keeps tenancy open. The security layout it implies, recorded so the habits
above point the right way:

| Layer | Tenant duty |
|---|---|
| EXP | Tenant and user from the token, never from a request body |
| PROC | The principal `{ tenant, user, roles }` on every request, SQS message, run, session and memory row |
| SERV | S5 and S6 with `tenant` added — every transaction sets the tenant and row-level security filters every table. Per-domain views over flexible records are `security_invoker`, or they read past the policy |

Deployment models: **silo** (a stack per household — needs R1), **bridge** (shared compute, a
database per tenant), **pool** (shared everything, isolated by row-level security).
