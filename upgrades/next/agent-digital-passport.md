<!-- bump: minor -->

## What Changed

Adds the **agent digital passport** — Salim Ismail's EXO 3.0 concept (from *The
80-Year Business Rule AI Just Broke*): "every AI agent gets a digital passport
with metadata saying what it's allowed to do and what it's not allowed to do,
and other agents watching that it's complying."

This packages Instar's existing primitives — agent identity (name + routing
fingerprint), trust level, and ORG-INTENT constraints — into one portable
passport, plus a deterministic compliance check a peer runs before trusting an
action:

- `GET /passport` → `{ version, agent, fingerprint, trustLevel,
  allowedCapabilities, forbiddenActions, issuedAt }`. `forbiddenActions` are
  drawn from the agent's ORG-INTENT constraints.
- `POST /passport/verify` `{ passport, action }` → `{ permitted, basis, reason,
  matched? }` where `basis` is `forbidden-action` | `trust-floor` (an untrusted
  passport may observe but not act) | `out-of-scope` | `ok`.
- A `/agent-passport` skill so agents reach for it proactively.

Deterministic + advisory — it answers "should I let this passport do this?"; the
caller decides. Pairs with the MTP Protocol (`/intent/org/test-action`).

## What to Tell Your User

Your agent now carries a digital passport — one portable card that says who it is (name + cryptographic fingerprint), how trusted it is, and exactly what it's forbidden to do (drawn straight from your organization's written constraints). When two agents work together, one can check the other's proposed action against that passport before trusting it: "is this allowed, forbidden, or outside your scope?" It's the EXO 3.0 idea that agents police each other's compliance — made real. Nothing changes in day-to-day use until agents start exchanging passports; there's nothing you need to configure.

## Summary of New Capabilities

- `GET /passport` — your own passport: `{ agent, fingerprint, trustLevel, allowedCapabilities, forbiddenActions, issuedAt }` (forbiddenActions = ORG-INTENT constraints).
- `POST /passport/verify` `{ passport, action }` — deterministic peer compliance check → `{ permitted, basis, reason }` (basis: forbidden-action / trust-floor / out-of-scope / ok). Advisory — the caller decides.
- `/agent-passport` skill — the proactive entry point before trusting a peer's proposed action.

## Evidence

Three-tier coverage, all green, `tsc --noEmit` clean:

- Unit — `AgentPassport.test.ts` (6): build defaults + `permits()` across every
  boundary (forbidden-action, trust-floor, out-of-scope, in-scope, unscoped).
- Integration — `agent-passport-routes.test.ts` (3): both routes over real HTTP,
  with ORG-INTENT constraints surfaced as the passport's forbidden actions.
- E2E — `agent-passport-lifecycle.test.ts` (2): a real server on a real port;
  `GET /passport` and `POST /passport/verify` alive end-to-end (200, not 404/503).

Skill registered in `installBuiltinSkills`; CLAUDE.md scaffold template documents
both endpoints.
