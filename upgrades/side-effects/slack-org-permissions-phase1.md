# Side-Effects Review — Slack org permissions Phase 1 (registration + enforce path)

**Version / slug:** `slack-org-permissions-phase1`
**Date:** 2026-06-09
**Author:** Instar Agent (echo)
**Second-pass reviewer:** REQUIRED (block/allow on inbound messaging) — see Phase 5 below

## Summary of the change

Builds on Slice 0 (the dark/observe-only Slack permission gate, merged in #1005). Phase 1 adds two things:
1. **Conversational registration** (`src/permissions/SlackUserRegistry.ts` + `src/server/routes.ts` `POST /permissions/registrations/{register,approve,deny}` + `GET …/pending`): admins register users with a role; self-registration creates a pending entry for approval. Persists to `state/slack-pending-registrations.json` (registered in `state-coherence-registry.json`).
2. **The enforce path** (`src/messaging/slack/SlackAdapter._handleMessage`): when the injected permission observer is **enforcing**, a non-`allow` verdict sends the conversational refusal/clarify reply (via the existing `sendToChannel`, in-thread) and returns — blocking the message from reaching the session. When NOT enforcing (the default), the observe call stays fire-and-forget exactly as in Slice 0.

Decision points touched: the inbound-message block/allow in `_handleMessage` (the enforce branch).

## Decision-point inventory

- `SlackAdapter._handleMessage` enforce branch — **add** — when `observer.enforcing`, a non-allow verdict blocks message processing + sends the gate reply. Dark by default (`enforcing=false` → unchanged observe-only behavior).
- `SlackUserRegistry` register/approve/deny — **add** — identity/role assignment; not a message gate (data layer feeding the principal resolver).
- `POST /permissions/registrations/*` routes — **add** — Bearer-gated admin/operator routes; classified INTERNAL (capabilities) like the rest of `/permissions`.

---

## 1. Over-block

When `enforcing=true`, the gate blocks any inbound message whose verdict ≠ `allow`. Over-block risk: a legitimate message mis-classified as floor/clarify is withheld from the session and gets a refusal/clarify reply instead. **Mitigation:** the path ships dark (default `enforcing=false`); the verdict logic is Slice 0's (floor = deterministic-conservative; the judgment band routes ambiguity to CLARIFY, which still replies to the user rather than silently dropping). Enabling enforce is gated behind a later phase that requires real FP-rate data from the observe ledger first (carried over from the Slice 0 §4 follow-up).

## 2. Under-block

When `enforcing=false` (default) the gate blocks nothing — identical to Slice 0 observe-only. That is intentional: Phase 1 ships the mechanism dark; it does not claim to protect anything yet. The registration layer does not itself enforce (a registered role only matters once the gate consumes it). No new protection is asserted.

## 3. Level-of-abstraction fit

Correct layer. The enforce decision sits in `_handleMessage` AFTER the fail-closed `authorizedUserIds` AuthGate and uses the SAME observer/verdict the observe path already produced — so it's the consume side of an existing signal, not a new parallel detector. Registration is a data layer (identity → role), feeding the existing `SlackPrincipalResolver`; it does not re-implement identity.

## 4. Signal vs authority compliance

**Required reference:** docs/signal-vs-authority.md. This is the change that turns the Slice 0 SIGNAL into an AUTHORITY (it can block) — so the compliance bar is real:
- The blocking authority is NOT brittle: the floor is deterministic-conservative-fail-closed; the judgment band is the injectable `IntentClassifier` (heuristic = deterministic test/fallback; LLM-backed in production) and routes ambiguity to CLARIFY, never to a silent allow. A blocked **directed** request (DM or @mention) always gets a conversational reply. (Precise nuance, per the second-pass review: the one no-reply block path is an *overheard/undirected* actionable message in `respondMode:'all'` — verdict `refuse/overheard/''` — which is correctly NOT actioned and NOT replied-to per §6.9; that is by design, not a silent drop of a directed user request.)
- It ships **dark** (`enforcing=false`), so the authority is installed but inert until a later, FP-data-gated phase explicitly enables it with the LLM judge holding the band — not the heuristic. **This artifact does NOT authorize `enforce:true`.**

## 5. Interactions

- **Shadowing:** the enforce branch runs in the same spot as the Slice 0 observe call (after AuthGate, before the mention-only skip). When enforcing, it returns early (blocks) — so it shadows the normal handler BY DESIGN for non-allow verdicts; when not enforcing it changes nothing.
- **Double-fire:** the observe ledger write and the enforce decision use the same single verdict; no double evaluation.
- **Races:** `SlackUserRegistry` writes `slack-pending-registrations.json` (single-writer per process, atomic write); the enforce decision is synchronous in the handler (no race with the fire-and-forget observe path, which only runs when NOT enforcing).
- **Registration vs gate:** an unregistered user resolves to the lowest role → the gate treats them conservatively; registration only ever raises trust via an explicit admin/approval action.

## 6. External surfaces

- **Other agents / install base:** none — dark by default (no permission observer attached unless configured); pure no-op for every existing agent.
- **External systems (Slack):** **no new Slack Web API calls** — the enforce reply reuses the existing `sendToChannel` (already contract-tested in Slice 0). The Slack API contract surface is unchanged by Phase 1 (verified: no new `client.*`/`postMessage` calls in the diff).
- **Persistent state:** one new file `state/slack-pending-registrations.json` (registered machine-local in `state-coherence-registry.json`). Created lazily; bounded.
- **HTTP:** four new Bearer-gated routes under `/permissions/registrations/*` (classified INTERNAL — agent-invisible while dark).

## 7. Rollback cost

Low / additive. Back-out = revert the 3 commits + ship a patch. No migration: `slack-pending-registrations.json` is observe/admin data (deletable with no consequence); the enforce branch is inert while dark, so reverting it changes nothing on any install (no one has `enforcing=true`). No agent-state repair, no user-visible regression.

## Phase 5 — Second-pass review

REQUIRED: this change adds a **block/allow decision on inbound messaging**. An independent reviewer must audit this artifact and append "Concur" or "Concern: …" below before the trace is written with `--second-pass true`.

## Second-pass review (independent reviewer)

**Concur with the review.** Verified against the actual code: the blocking authority is genuinely fail-closed — the floor (`SlackPermissionGate` lines 140–180) is deterministic, regex-detected via `HeuristicIntentClassifier` (no LLM in the floor path), `roleCanAuthorizeFloor` clears only `owner`/explicit grant, an unregistered user resolves to `guest`/`registered:false` and is refused, ambiguity routes to `clarify` (line 131), and `NullAnomalyScorer` (default) can't spuriously raise step-up; the enforce branch sits after the fail-closed AuthGate, reuses the single observe verdict, and is genuinely inert when `enforcing=false` (`observer.enforcing` → `deps.enforce ?? false` → original fire-and-forget path, proven by the `enforcing=false` unit test), with no new Slack API calls (reuses pre-existing `sendToChannel`; diff grep for `client.*`/`postMessage`/`chat.*` additions returns none).

*Minor wording nuance (not a blocker, no code change needed):* §4's "a blocked message **always** gets a conversational reply" is slightly overstated. The one non-allow verdict carrying an empty message is `refuse / overheard / ''` (gate line 108), reachable only for an **undirected** (non-DM, non-mention) actionable message in `respondMode:'all'` — in that case the enforce branch blocks with no reply (`if (verdict.message)` is false → silent `return`). This is correct by design (an overheard command must not be actioned per §6.9, and replying to a message not directed at the bot would be channel noise) — it is not a silent drop of a *directed* user request, and it ships dark regardless. Worth a one-word softening of §4 ("a blocked *directed* request always gets a reply") at the authoring agent's discretion; the behavior itself is sound.
