# Side-Effects Review — "Open session" for the Instar iPhone app

**Version / slug:** `mobile-open-session`
**Date:** `2026-11-03`
**Author:** `Echo`
**Second-pass reviewer:** `independent subagent (see the end of this file)`

## Summary of the change

Operator request (Justin, 2026-11-03 12:10 PST): an "open session" button in the app that takes him straight to the dashboard session driving the chat, and says so when no session is running.

New device-signed read route `GET /mobile/conversations/session?ref=<ref>` (`src/server/mobileSessionRoutes.ts`, mounted in `AgentServer` beside the media router). `ref` takes the media routes' three shapes (`app:<uuid>`, `telegram:<topicId>`, a Slack `conversationKey`) with the same "held by this machine" checks (live app conversation; Telegram topic in this machine's mappings; Slack key minted by this machine's registry with `slackOwnerUserId` set). The phone's person must be allowed to use the conversation (`deviceMayUse`), otherwise 404 like an unknown one.

Answer: `{ active, sessionName?, startedAt?, framework?, machineNickname, dashboardUrl?, reason?, ownerMachine? }`.
- `active:true` only when the conversation's bound tmux session has a **running** session record on this machine (the same records the dashboard lists, so the deep link finds it).
- `dashboardUrl` = `<origin>/dashboard?session=<encoded tmux name>` (`dashboardOriginFor`). Origin: with multi-route on, the own name this request's signature was verified against (listed for this machine, arrived through its own local TLS front); else `pairing.pairingOrigin()` (running Cloudflare named tunnel, else a verified Tailscale own name) unless an active sibling machine claims that host (the same `siblingClaiming` check pairing's mint uses); else the paired host the signature was verified against. Never a token, PIN or signature.
- No session: `active:false`, `reason` "No session is running for this chat right now; your next message starts one."
- Another machine owns it (Telegram: ownership registry, else the lease holder; app: the lease holder when this machine is not it): `active:false`, `reason` naming that machine, `ownerMachine: {machineId, nickname}`. No proxy: the owner's route refuses Bearer, so a pool proxy is not trivial.

The dashboard already deep-links with `?session=<tmuxSession>` (`handleDeepLink`, runs after the PIN overlay closes). The only dashboard change: its wait for the first session list grows from 3 s to 10 s, so a phone over a tunnel does not miss it.

The device allowlist gains `GET /mobile/conversations/session` (active devices, no body, `conversationRef: true`). CapabilityIndex describes it.

Tier 1: read-only route behind the existing dev-gated `mobilePairing` gate, one allowlist entry, a revert removes it entirely. Size: 1 new module (~150 lines), ~35 lines of wiring, 2 lines allowlist, 3 lines dashboard, 3 test files. Effort: one design pass, no spec rounds.

## Decision-point inventory

- Device allowlist — add — one GET route, active devices only, flagged as naming a conversation.
- Whether the phone may read a conversation's session — pass-through — the existing `deviceMayUse` people-and-roles check.
- "Active" — add — a running session record bound to the conversation on this machine (a signal shown to the operator, not a gate on anything).

## 1. Over-block

A session that is alive in tmux but whose record is not yet `running` (seconds after spawn) reads `active:false`; the next tap shows it. A conversation this machine does not hold (a Telegram topic only another machine maps, a Slack key minted elsewhere) answers 404, the same as the media routes; the app asks the machine that listed it. Telegram on a standby with no Telegram adapter answers 404 for every topic.

## 2. Under-block

The route only reads; it reveals a tmux session name, start time and framework for a conversation the phone may already use. Those are already visible to the same owner on the PIN-locked dashboard and (for the owner) in `GET /sessions`, which is already on the device allowlist. An MSP phone gets 404 for conversations it may not use. The link carries nothing secret; the dashboard still needs its PIN.

## 3. Level-of-abstraction fit

The decision is a pure function (`resolveOpenSession`) with the machine lookups injected from `AgentServer`, which already owns the Telegram adapter, Slack bridge, conversation service, session manager and pool registries. The deep link reuses the dashboard's existing `?session=` handling rather than adding a parallel one.

## 4. Signal vs authority compliance

No authority added. The route reports state; it blocks nothing and changes nothing. Access control is the existing device authenticator plus the existing `deviceMayUse` check (`docs/signal-vs-authority.md`: no brittle check gains blocking power).

## 5. Interactions

`GET /mobile/conversations/session` sits beside `PATCH/DELETE /mobile/conversations/:key`; those take a strict UUID and there is no `GET /mobile/conversations/:key`, so no route shadows it. The allowlist regex for PATCH/DELETE uses the UUID pattern and cannot match `session`. The read uses the shared per-device read allowance, like the other reads. The DEVICE_ALLOWLIST coverage test now lists this route.

## 6. External surfaces

The iPhone app gains one read endpoint. The answer shape is additive and new. No change for agents, other machines, Telegram or Slack. The dashboard change is a longer wait for an already-supported deep link.

## 6b. Operator-surface quality

The only operator-surface change is the dashboard's existing `?session=` deep-link handler waiting up to 10 s (was 3 s) for its first session list. No markup, label or control changes.
1. **Leads with the primary action?** Yes: the link opens the dashboard on the Sessions tab with the session already selected and streaming, after the usual PIN; nothing to find or tap.
2. **Zero raw internals as primary content?** Yes: no new content is shown. The tmux name stays in the URL query only, as it already did when the dashboard recorded the active session.
3. **Destructive actions de-emphasized?** Not affected: no actions are added or moved; the existing session tile and its controls are unchanged.
4. **Plain language + phone width?** Unchanged dashboard rendering; the longer wait exists precisely so the focus works on a phone over a slower tunnel. The app's button and its "no session" sentence are plain language (`reason` strings are written for the operator).

## 7. Multi-machine posture (Cross-Machine Coherence)

Proxied-by-name, not proxied-on-read: each machine answers for its own sessions. When the conversation's owner (ownership registry or lease holder) is another machine and no local session runs, the answer names that machine (`ownerMachine`), so the app can ask it or tell the operator where to look. A local running session always wins, so a stale ownership record never hides a real session. The dashboard URL is built so it cannot open a sibling's dashboard: a multi-route request uses the own name it was verified on; otherwise the pairing origin is used only when no active sibling claims its host. Without multi-route and with a shared host that the sibling registry does not report, the link could still reach whichever machine the tunnel routes to; the dashboard then finds no matching session and simply opens without focus (no wrong action, only a missed focus). A full proxy is not built: the owner's route accepts only device signatures, which a peer cannot forward.

## 8. Rollback cost

Revert the commit. No state, no migration, no config. Phones that call the route afterwards get 403 `device-not-allowed`; the app should treat that as "not available on this agent".

## Second-pass review

**Reviewer:** independent subagent (read-only, given the code and this artifact, not my conclusions).

**First pass — Concern raised:**
1. The link could open a sibling's dashboard: `pairingOrigin()` only checks that a named tunnel runs here, while pairing's mint also refuses a host an active sibling claims. Suggested: prefer the verified own name with multi-route on; use the pairing origin only when `siblingClaiming` is null. §7 overclaimed.
2. The unconfirmed-owner reason showed a raw machine id in user-facing text.
3. No test locked in that `ref` is covered by the signature, that the notify token is refused, or that an MSP phone gets 404 (the §2 claim).
Minor: the Slack lookup searched a 500-row capped list; three lookups were not try-wrapped.

**Fixes:** (1) `dashboardOriginFor` implements exactly the suggested order, with unit tests for each branch, and §7 is corrected. (2) The id is gone from the sentence (it stays in `ownerMachine.machineId`); a unit test asserts it. (3) Integration tests added: a ref changed after signing → 401; notify token → 403; MSP phone → 404 for an app conversation it does not own and for a Slack chat without the grant, 200 for the owner's phone. Minor: the Slack session lookup now resolves the registry entry by key directly; every injected lookup is try-wrapped.

**Recheck (same reviewer, read-only, after the fixes): "Concur with the review."** It confirmed each fix at its line: `dashboardOriginFor`'s order and try-wrap, the id gone from the reason, the new integration and unit tests, the exact Slack routing key from `resolveByKey`, and every injected lookup try-wrapped. Remaining notes needed no change (per-request `listRunningSessions` cost matches `GET /sessions` and is device-rate-limited; the e2e dashboard check is a string match on the served page).

Agent awareness: a new bullet (`APP_CONVERSATIONS_OPEN_SESSION_LINE`) in the Native app conversations CLAUDE.md section, inserted for existing agents by `migrateClaudeMd` after the pool-read line (content-sniffed, idempotent; unit-tested).
