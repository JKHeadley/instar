---
title: "Phase-0 deploy runbook — canonical feedback front (receiver + dispatch) to Vercel"
status: prep — binding design + cred checklist ready; actual deploy is cred-gated (Justin/Dawn) and DB-target-gated (Q2b)
author: Echo (autonomous session 3, 2026-06-05)
relates-to: feedback-factory-migration.md §2.2, §2.5 Phase 0; feedback-migration-q2b-write-seam-proposal.md
---

# Phase-0 deploy runbook

**Goal (spec §2.5 Phase 0):** deploy receiver + dispatch to the canonical Vercel front, same
shared secret, NO live traffic. Gate: *"deploy healthy, secret HMAC round-trips."* Fully
revertible (delete the deploy).

## What's already done (grounded)

The ported handlers are **already framework-agnostic** and merged to `JKHeadley/main`:
- `src/feedback-factory/receiver/handlers.ts` → `handleFeedbackSubmit(req, deps)` — a pure
  `FeedbackRequest → FeedbackResponse` function over the `FeedbackStore` + `RateLimiter`
  interfaces. Its own header: *"the canonical front (Vercel function / Next route / instar
  server) is a thin binding that maps its req/res to this."*
- `src/feedback-factory/receiver/defense.ts` — the intake defenses (IP extract, honeypot,
  HMAC `verifySignature`, type validation, semver/agent-name/node-version/feedback-id regexes).
- `src/feedback-factory/dispatch/dispatch.ts` + `handlers.ts` — the guidance-out path.

So Phase-0 is **a thin binding + deploy config + the HMAC round-trip test**, NOT a re-port.

## The binding to build (not yet built)

1. **`api/instar/feedback.ts`** (Vercel function) — maps Vercel `(req, res)` →
   `FeedbackRequest` (headers, body, remoteAddress) → `handleFeedbackSubmit(req, deps)` →
   writes `FeedbackResponse.status/headers/json` back to `res`. `deps.secret` =
   `normalizeWebhookSecret(process.env.INSTAR_WEBHOOK_SECRET)` (trimmed at load — the structural
   fix for the trailing-newline scar). `deps.now = Date.now()`. `deps.store` = the real store
   (see DB target below). `deps.rateLimiter` = a process-local limiter (Vercel is stateless per
   invocation → a shared limiter needs a small KV/edge store; for Phase-0 no-traffic health it
   can be in-memory, but note the production rate-limit needs a durable backing — flag at deploy).
2. **`api/instar/dispatches/index.ts`** (Vercel function) — same binding shape over the dispatch
   handler.
3. **`vercel.json`** — function routing for `/api/instar/feedback` + `/api/instar/dispatches`;
   Node runtime pinned to match the processor's Node (the `NODE_VERSION_RE` fingerprint axis).
4. **Tier-3 "feature alive" test** — boot the binding (or a local Node http shim over the same
   handler), POST a correctly-HMAC-signed body with an **in-memory `FeedbackStore`**, assert
   200 + the dispatch round-trip; POST a wrong-signature body, assert the reference's reject
   status. This proves the Phase-0 gate ("HMAC round-trips") with NO real DB or secret.

## DB target — GATED on Q2b (see the write-seam proposal)

The receiver WRITES raw `InstarFeedback` rows. Which DB it writes to depends on the Q2b
decision:
- **Option B (recommended):** the front writes to **Echo's own operated DB** (Echo owns it,
  no Prisma-role constraint). Clean. The Vercel function's `DATABASE_URL` points at Echo's DB.
- **Option A:** the front would write to Portal's **shared** DB — which hits the same
  `CREATE ROLE`/`GRANT` constraint as the write-path, so even the receiver needs the
  HTTP write-seam. This is additional evidence for Option B.

→ The binding code is **identical either way** (store is injected); only the deploy-time
`DATABASE_URL` / store factory differs. So the binding + test can be built now; the store
wiring is set at deploy once Q2b is decided.

## Exact creds / inputs needed at deploy (the cred-gated boundary)

| Input | Owner | Notes |
|-------|-------|-------|
| Vercel project (the "Instar canonical front") | Justin/Echo | new or existing project; the front is stateless HTTP |
| `INSTAR_WEBHOOK_SECRET` | Dawn (shared key through cutover) | **same** key as Portal through cutover (§2.9 — per-operator keys are post-cutover); trimmed at load |
| `DATABASE_URL` | per Q2b | Echo's own DB (Option B) or the shared write-seam (Option A) |
| Durable rate-limit backing | Echo | Vercel KV / edge store for the per-IP 10/hr limit in production (in-memory only ok for Phase-0 health) |

## Sequence (when unblocked)

1. Q2b decided (Dawn) → fixes the `DATABASE_URL` / store factory.
2. Build the binding + vercel.json + Tier-3 HMAC test (fresh worktree off `JKHeadley/main`,
   full instar-dev gate). **Not Q2b-blocked — can build now; only the deploy step waits.**
3. Justin/Echo provision the Vercel project + env (secret, DB URL).
4. Deploy with NO sender repointed (no live traffic). Verify health + HMAC round-trip against
   the live URL. Revert = delete deploy.
5. Phase 0 complete → Phase 1 (Dawn's code-owner review, via the mandate) gates live traffic.

## Note

This is operational prep, not a Justin-facing decision. The only Justin/Dawn inputs are the
creds table above and the Q2b call — both already surfaced. Building the binding + test is
clean solo work whenever it's sequenced ahead of the higher-priority mandate-enforcement build.
