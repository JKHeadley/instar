---
title: "Agent-driven sign-in repair — the minimal first version"
slug: agent-driven-relogin
author: echo
owner: echo
topic: 33890
status: approved
approved: true
approved-by: "Justin (Telegram topic 33890, 2026-09-24 08:04 PDT: \"Yes … enter a 24 hour autonomous session to finish out this feature\")"
parent-principle: "Judgment Within Floors and Signal vs Authority (docs/STANDARDS-REGISTRY.md): the model judges the next browser step inside deterministic floors, and holds no authority over success. Also the proposed Skills-over-Scripts / Simplest-Robust-Route standard (ACT-042) and the operator's fractal 80/20 + Occam's razor direction (2026-09-24)."
depends-on:
  - assisted-subscription-relogin
review-convergence: "2026-09-24T15:09:19.286Z"
review-iterations: 1
review-completed-at: "2026-09-24T15:09:19.286Z"
review-report: "docs/specs/reports/agent-driven-relogin-convergence.md"
cross-model-review: "codex-cli:gpt-6-astra"
single-run-completable: true
frontloaded-decisions: 5
cheap-to-change-tags: 0
contested-then-cleared: 0
---

# Agent-driven sign-in repair — the minimal first version

## Problem statement

The assisted re-login engine detects an expired Claude or Codex sign-in, decides a repair is allowed, drives the account's own Chrome through the provider sign-in, and verifies the right account came back. Its browser step is a fixed script: it sorts each page into a closed set of classes and may only take the one action allowed for that class. On a page nobody predicted, the script can only wait and give up. On 2026-09-23 the ledger showed zero completed repairs ever, and one afternoon surfaced four unforeseen transitions in a row (#2055–#2058). An agent reading the page handled every one by hand in seconds.

An 18-round review of a large redesign (a spawned agent session, a socket actuator, a tool-boundary hook, lock files, daily caps, experiment arms) never converged: each fix added machinery the next round found fault with. The operator stopped it (2026-09-24 08:04 PDT) and approved the small version below.

## Proposed design

**One change, in the existing driver: on every page that is not a terminal or safety page, the choice of what to do next is made by a model reading the page, instead of by the page-class table.**

The existing `AnthropicReloginBrowserDriver` already runs a loop — snapshot the page, enforce floors, ask a model (`supervise`) to pick one action from a closed list, perform it. Today the list is fixed per page class, and an `unknown` page offers only `wait`. The change:

1. **Open action list.** Besides the existing typed actions (choose the expected account, fill email / password / TOTP / device code, next, authorize, wait), every visible, enabled control on the page is offered as `click:<n>`, labelled by its visible text. Nothing is keyed to a page class, so a page nobody predicted is still actionable. A `give-up` action ends the drive as a transient.
2. **The instructions are the skill.** The model's prompt says what signing in means for this provider and login method, lists the page facts and the recent steps, and asks for one action token. It is a prose instruction, not a page catalog.
3. **The model** is the shared internal intelligence provider through the existing `LlmQueue` (routed by per-component framework routing; off Claude by default), with a larger token budget than the Tier-1 validator had. No agent session, no tools, no socket, no hook: the model can only return a token from the offered list.

### The floors (deterministic, in the runtime — the only things that must never be wrong)

| Floor | How it holds |
|---|---|
| Stay on the real sign-in sites | Existing per-step origin check (`allowedOrigins`); off-list ⇒ `refused / unexpected-origin`. The runtime alone navigates to the sign-in URL. |
| Never pick the wrong account | A control whose text or `data-email` / `data-identifier` names any email other than the expected one is never offered and is re-checked at click time; the existing account-chooser rule (exactly one expected match) stays; `verifyIdentity` after sign-in still quarantines a mismatch. |
| Never show the model a password or code | Fills are typed roles resolved in the runtime (vault / TOTP seed / device code); the model never sees a value. The outbound payload is a fixed schema — provider, login method, origin, path (no query string), page-class hint, the numbered control list `{n, label}` (label = the visible text of a button or link, or a submit input's value; never any other input's value), the input kinds present (email, password, code…) with no values, whether the expected account is visible, and the last few steps. Every secret value resolved in this drive is stripped verbatim from every label before sending, then: Offered labels are trimmed to 60 characters with an explicit `…(truncated)` marker when cut, other emails masked, long token-like strings and digit runs masked; controls are numbered, so two controls with the same visible label stay distinguishable. The paste code is read by the runtime, never offered. |
| Never approve more permissions than allowed | Existing check before any action: requested scopes must be within `allowedScopes`, else `operator-only / permission-expansion`. An authorize page with no readable scopes still refuses. |
| Never touch account settings or create credentials | (A deterministic block on irreversible actions — the Signal-vs-Authority exemption for safety guards on irreversible actions.) Controls whose text contains a destructive or credential-creating phrase (sign out, log out, delete, remove, forgot password, change password, security, manage, add account, use another account, create api key, buy, upgrade, invite, cancel plan, create a passkey, create passkey, add passkey, set up, turn on, add phone, add recovery, save password) are never offered. Agent navigation applies to sign-in drives only; passkey *enrollment* drives keep the closed list. |
| Never grant permissions blind | A control labelled allow / authorize / approve / accept / grant (or any control on an `authorize`-class page) is offered only when the page's requested scopes were read, are non-empty, and are within `allowedScopes` — so an unrecognized consent page cannot be clicked through with unmeasured scopes. |
| One repair per profile at a time | Existing `PlaywrightSeatLease` (host-wide, stricter than per-profile). |
| Hard time limit | A drive deadline (default 8 minutes) enforced by racing every model call and browser operation against the remaining time (the drive aborts and closes the browser when it passes — a stalled call cannot outlive it), with bounded browser close before the lease is released, plus the existing step budget (raised from 20 to 40 in agent mode) and the existing 90-second hold wait for Cloudflare's "Just a moment" page. |

Terminal and safety pages keep their existing deterministic handling unchanged: hold (wait), CAPTCHA and risk challenge (`operator-only / captcha`), phone confirmation (`operator-only`), passkey terminal pages, success, paste code. The model is never asked about them.

### Selection and rollout

Maturation path (test agent → development agent → fleet): **test agent** = the integration tests, which drive fixture sign-in pages (including a page no classifier knows) through real Chrome with the real driver; **development agent** = Echo's three machines, where success is a real product-triggered repair; **fleet** = a later, separate flip of the default once Echo shows repeated real repairs with no security refusals.


`subscriptionPool.assistedRelogin.navigation`: `'agent' | 'closed'`. Omitted ⇒ `resolveDevAgentGate` ⇒ `agent` on a development agent (Echo's three machines), `closed` on the fleet. An explicit value always wins. Nothing else in the engine changes: admission, approval, the episode store, retries, breakers, `finishCli`, `verifyIdentity`, `verifyAuthenticatedUse`, notices.

### What is deliberately not built

Everything the 18-round design added beyond the list above — a spawned agent session, a socket actuator, a tool-boundary hook, kernel lock files, daily drive caps, a driver-alternation experiment, a click-audit table, locale pinning, per-issuer scope binding — is not built. Each can be added if real repairs show it is needed.

## Decision points touched

| Decision point | Classification | Floor / justification |
|---|---|---|
| Next browser action | judgment-candidate | The model exercises real authority over which offered action runs (not over success). Floor: the offered list is filtered by the deterministic floors above, re-checked at action time; conservative default: `give-up` / `wait`; fallback ladder: step budget → deadline → existing retry and breaker. Arbiter: `verifyIdentity` + `verifyAuthenticatedUse`, never the model. |
| Origin, identity, scope, destructive-control, secret floors | invariant | Deterministic checks in the runtime, above. |
| Navigation mode selection | invariant | Explicit config, else the development-agent gate. |

## Multi-machine posture

machine-local-justification: physical-credential-locality impossible-because="Chrome-app-bound-cookie-encryption" permanence=permanent

Each repair drives the Chrome profile and fills the Claude/Codex config home of the machine it runs on; the Google session in that profile is bound to that machine's disk. The setting is per machine; episode metadata, notices and the existing one-voice gating are unchanged.

## Maturation plan

- **test-agent-live:** Rung 1 — the integration tests drive local fixture sign-in pages (including a page no classifier knows, a consent page with unreadable scopes, a destructive control, a second account) through real Chrome with the real driver and a scripted model; no real account is touched.
- **dev-agent-live:** Rung 2 — Echo's three machines, where `navigation` resolves to `agent` through the development-agent gate; Echo already runs the engine in unattended mode for its listed identities, so a real expiry is repaired with no human step.
- **fleet:** Rung 3 — every other agent keeps `closed` until the graduation criterion passes; the fleet default flips in a later, explicit release.
- **graduation criterion:** at least 5 product-triggered agent-navigated repairs verified by `verifyIdentity` and `verifyAuthenticatedUse` across both providers on Echo, with zero wrong-identity, unexpected-origin or permission-expansion refusals caused by an agent choice.
- **dark-window:** minimum 14 days development-agent-only; any security refusal traced to an agent choice resets the window.

## Residual risk, named

The floors do not prove every offered control is harmless: a generically labelled control on an allowed sign-in page could, in principle, change an account setting. That residual is bounded by the origin list (sign-in sites only), the destructive-phrase block, the model's instructions, and the one-repair-at-a-time lease, and it is the reason the fleet stays on `closed` until real repairs are observed.

## Verification (P20)

- **Symbol:** the model's chosen action. **State claimed:** progress toward sign-in. **Corroboration:** none needed — it holds no authority; success is decided only by `verifyIdentity` (slot tenant equals expected email) and `verifyAuthenticatedUse`. **Unmeasurable:** an invalid or missing token ⇒ the drive ends `transient`.

## Self-Heal Before Notify

Not applicable: no new watcher or notice source.

## Frontloaded Decisions

1. The agent is an in-runtime model call with an open, floor-filtered action list — not a spawned session (Occam: no tool boundary to build or defend).
2. Terminal/safety pages keep deterministic handling; only navigation is delegated.
3. Destructive-phrase list, 60-character labels, 8-minute deadline, 40 steps.
4. Dev-gated via `navigation`; the fleet keeps `closed`.
5. Done = a real, product-triggered expiry repaired unattended on Echo's machines (ledger row `succeeded`).

## Open questions

*(none)*
