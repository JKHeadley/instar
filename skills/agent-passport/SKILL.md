---
name: agent-passport
description: View this agent's digital passport (identity + trust + allowed/forbidden actions) and verify a peer's passport against a proposed action (EXO 3.0).
metadata:
  user_invocable: "true"
---

# /agent-passport

Salim Ismail's EXO 3.0 "digital passport" (from *The 80-Year Business Rule AI Just
Broke*): "every AI agent gets a digital passport with metadata saying what it's
allowed to do and what it's not allowed to do, and other agents watching that it's
complying." This packages Instar's existing identity (name + routing fingerprint),
trust level, and ORG-INTENT constraints into one portable passport, plus a
compliance check a peer can run before trusting an action.

## When to use
- Hand a peer your passport so it can decide what it'll let you do.
- Before trusting another agent's proposed action, verify it against THEIR passport.

## How
Your own passport:
```bash
curl -H "Authorization: Bearer $AUTH" http://localhost:${INSTAR_PORT:-4042}/passport
```
Returns `{ version, agent, fingerprint, trustLevel, allowedCapabilities, forbiddenActions, issuedAt }`. `forbiddenActions` come from your ORG-INTENT constraints.

Verify a proposed action against a passport (the peer-watches-compliance check):
```bash
curl -X POST -H "Authorization: Bearer $AUTH" -H 'Content-Type: application/json' \
  -d '{"passport":{...},"action":"wire funds to a new vendor"}' \
  http://localhost:${INSTAR_PORT:-4042}/passport/verify
```
Returns `{ permitted, basis, reason, matched? }` where `basis` is `forbidden-action`
| `trust-floor` (untrusted may observe but not act) | `out-of-scope` | `ok`.
Deterministic + advisory — it answers "should I let this passport do this?"; the
caller decides. Pairs with the MTP Protocol (`/intent/org/test-action`).
