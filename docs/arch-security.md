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
  manipulate workflow execution. Covered by the right-brain validation loop.

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
| Prompt injection | Right-brain validation loop — Ajv + AST gate | ✅ Implemented |

## 5. What Is Deliberately Not Done

- **No VPC on Lambda** — cost decision ($32/month NAT Gateway avoided). Final — do not suggest VPC.
- **No WAF** — AWS WAF adds ~$5-10/month minimum. Not justified at this scale.
- **No API keys on Slack endpoints** — Slack signing secret is the correct mechanism.
- **No SigV4 signing on PROC→SERV calls** — API key in env var achieves equivalent
  protection without requiring AWS SDK credential management in serv-client.mjs.
- **No separate key per caller** — single internal key for this household deployment.
  Rotate via SSM parameter update + redeploy if compromised.
