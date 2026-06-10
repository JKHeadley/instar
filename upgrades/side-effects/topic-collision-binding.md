# Side-Effects Review — getTopicBinding collision disambiguation

**Version / slug:** `topic-collision-binding`
**Date:** `2026-06-09`
**Author:** `Instar Agent (echo)`
**Second-pass reviewer:** `independent reviewer subagent — concurred`

## Summary of the change

`SessionManager.getTopicBinding(tmuxSession)` did a single-match reverse lookup over `registry.topicToSession` and returned the FIRST topic mapping to the session. When two topics whose names slug to the same tmux name collide onto one session, this returned the wrong (first-registered) topic, so the InputGuard's provenance check blocked the other topic's messages as cross-topic (session silently unresponsive). The fix: `getTopicBinding` now collects ALL matching topics and accepts an optional `preferTopicId`; if that topic is among the matches it binds to it, else falls back to the first match. The `injectMessage` call site parses the message's own `[telegram:N]` tag (`/^\[telegram:(\d+)/`) and passes it. Files: `src/core/SessionManager.ts` (getTopicBinding + injectMessage call site), `tests/unit/topic-collision-binding.test.ts` (new, 6 cases).

## Decision-point inventory

- `SessionManager.getTopicBinding` (feeds the InputGuard cross-topic provenance decision) — **modify** — single-match → all-matches + tag-preferred disambiguation. Single-topic behavior unchanged.
- `injectMessage` InputGuard provenance check — **pass-through (caller updated)** — now passes the parsed tag so the binding can disambiguate; the provenance comparison logic itself is unchanged.

## 1. Over-block

This change strictly REDUCES over-block. Before, a legitimate message from a colliding topic was blocked (the bug). After, it binds to the correct topic and passes. No new legitimate input is now blocked. The InputGuard's actual block decision (`checkProvenance`) is untouched — only the binding it is handed is now correct on collision.

## 2. Under-block

Could this let a genuinely cross-topic message through? No. `preferTopicId` only changes the binding when the named topic is ACTUALLY in the set of topics mapped to this session. A message whose tag names a topic NOT mapped to this session falls back to the first match, and the InputGuard then still detects the mismatch and blocks — identical to today. So the cross-topic protection is preserved; only the legitimate-collision false-positive is removed. (Edge: if two colliding topics are both legitimately the "same" conversation split across ids, binding to whichever the message names is correct by construction.)

## 3. Level-of-abstraction fit

Correct layer. The collision is a registry-reverse-lookup ambiguity; resolving it where the lookup happens (`getTopicBinding`), using a signal already present at the call site (the message tag), is the right altitude. The alternative — making tmux session names unique per topic — is a larger, migration-bearing change to session-name derivation affecting every session; this binding-layer fix is migration-free and lower-risk, and is the proportionate fix for the observed failure. (The name-uniqueness change remains a possible future hardening but is not required to close this bug.)

## 4. Signal vs authority compliance

**Required reference:** [docs/signal-vs-authority.md](../../docs/signal-vs-authority.md)

- [x] No — this change has no block/allow surface of its own; it corrects the INPUT (the binding) to the existing InputGuard authority so that authority decides on accurate data.

It does not add or weaken any gate. It makes the existing cross-topic authority decide against the correct topic binding instead of an arbitrary first-match. Compliant.

## 5. Interactions

- **Shadowing:** none — same call order; `getTopicBinding` → `checkProvenance` unchanged in sequence.
- **Double-fire:** none.
- **Races:** `getTopicBinding` reads the registry file fresh each call (unchanged); no new shared state. The disambiguation is pure over the read snapshot.
- **Other callers:** the only caller of `SessionManager.getTopicBinding` is `injectMessage` (the new optional param defaults to undefined → first-match, so any future caller is back-compatible). `ScopeVerifier.getTopicBinding` is a DIFFERENT method (topic→project) and is untouched.

## 6. External surfaces

- **Agents/users:** ships to the install base via the normal release. User-visible effect: messages to a topic that shares a session name with another topic now reach the session instead of being silently dropped. No API/format change.
- **Persistent state:** none — reads the existing registry; writes nothing.
- **Timing:** depends only on the message text tag (already present at injectMessage) and the registry snapshot (already read).

## 7. Rollback cost

Pure code change, no persistent state, no migration. Back-out = revert the commit, ship a patch; behavior returns to first-match reverse lookup. Low. (The original incident's manual recovery — `/unlink` of the stale topic — is independent and already applied.)

## Conclusion

A migration-free, scope-narrowing fix: it removes a false cross-topic block on legitimately-colliding topics by handing the existing InputGuard authority an accurate binding (resolved via the message's own tag), while fully preserving genuine cross-topic protection and single-topic behavior. Because it feeds a message-dispatch/session-lifecycle decision point, a Phase-5 second-pass review is requested.

## Second-pass review (if required)

**Reviewer:** independent reviewer subagent (general-purpose)
**Independent read of the artifact: concur**

Concur. The reviewer traced all three resolution cases against the code (tagged→tagged topic, null→first, unknown→first) and confirmed they match the tests. Critically, it verified the security invariant cannot be bypassed: `preferTopicId` only wins via `matches.includes(preferTopicId)` — i.e. only when the tagged topic is genuinely served by THIS session — so a crafted/foreign tag falls through to first-match and InputGuard.checkProvenance still detects the mismatch and blocks (the change can only NARROW the binding to an already-served topic, never widen the served set). Tag parsing `/^\[telegram:(\d+)/` is byte-identical to InputGuard's `extractTelegramTag`, so the select-value and verify-value can never diverge. Back-compat confirmed: optional param defaults to undefined→first-match; the public `injectMessage` signature is unchanged so its external callers (mostly non-Telegram-tagged `/compact`/bootstrap text) get `preferTopicId=null` → identical old behavior; `ScopeVerifier.getTopicBinding` is a different method, untouched. `preferTopicId != null` correctly admits 0 (no zero-is-falsy bug). Two non-blocking notes: (1) "first match" is V8 lowest-numbered-integer-key order, not literally first-registered — only the pre-existing fallback, acceptable; (2) registry-read fail-open is pre-existing and out of scope.

## Evidence pointers

- Live incident: 2026-06-09, topic 2169/21624 — `[InputGuard] BLOCKED cross-topic injection … bound to topic 21487`; registry showed 21487+21624 → one session; first-match returned 21487.
- Tests: `tests/unit/topic-collision-binding.test.ts` (6 cases, both sides). 63 existing SessionManager + InputGuard tests green; tsc + lint clean.
