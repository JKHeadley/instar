# Side-Effects Review — Threadline duplicate-identity resolver (PR1: client live-preference)

**Version / slug:** `threadline-dup-identity-pr1-resolver`
**Date:** `2026-06-09`
**Author:** `Instar Agent (echo)`
**Second-pass reviewer:** `independent reviewer subagent — CONCUR (Phase 5; high-risk: name→fingerprint dispatch resolution)`

## Summary of the change

Closes the duplicate-identity silent-drop class on the exact path a sender uses
(`threadline_send` → `ThreadlineClient.resolveAgent` → `findAgentByName`). Driven by the
converged spec `docs/specs/threadline-duplicate-identity-resolution.md` (changes A/B/C).
Single file touched: `src/threadline/client/ThreadlineClient.ts`. (A) `KnownAgent` gains an
`online` flag, merged — never replaced — from the relay's `discover_result.status` (the relay
already derives that status from live presence; the client was discarding it). (B)
`findAgentByName` prefers the single live registration among same-name rows in both the exact and
partial branches, and still throws ambiguity when ≥2 are online (never silently picks). (C)
`resolveAgent` re-discovers once (cooldown-gated, rate-limit-aware) when the cached match is
offline, so a stale dead twin can be superseded by a live one. Tests: 17 unit on the real
resolver + 1 relay-backed e2e (live-vs-dead echo → resolves to live).

## Decision-point inventory

- `ThreadlineClient.findAgentByName` (name → fingerprint resolution) — **modify** — adds a
  live-registration preference before the existing ambiguity throw; the throw is preserved for
  genuinely-ambiguous (≥2 online, or all offline >1) cases.
- `ThreadlineClient.resolveAgent` (cache → re-discover orchestration) — **modify** — adds one
  cooldown-gated re-discovery when the resolved match is offline.
- `ThreadlineClient.discover` (relay discovery wait) — **modify** — adds a rate-limit-filtered
  early-resolve so a throttled re-discovery fails fast instead of hanging to the 10s timeout.
- `ThreadlineClient` discover-result ingestion — **modify** — merge (not replace) so a keyless
  discovery frame cannot strip crypto keys; map `status` → `online`.

---

## 1. Over-block

**What legitimate inputs does this change reject that it shouldn't?**

No new block/allow surface. The one place resolution can now *fail* where it previously
"succeeded" is when ≥2 same-name rows are simultaneously online — but that failure is the
existing ambiguity throw, which is the correct, pre-existing behavior (require `name:fingerprint`).
A legitimately-multi-machine agent (two keys, both online) now gets that loud ambiguity rather
than an arbitrary pick — intended, and the error text points at the disambiguation syntax + saved
nicknames. No legitimate single-recipient send is newly rejected: a live-vs-dead pair now resolves
(previously it threw or silently dropped); a single offline peer still resolves (returns the
offline fingerprint, preserving offline-queue semantics).

---

## 2. Under-block

**What failure modes does this still miss?**

Name discovery remains trust-on-first-use and unauthenticated at the relay (the `name` is not
cryptographically bound — pre-existing, documented in the spec's §Security). If the real agent is
genuinely offline AND only an impostor with the same name is online, the exactly-one-online rule
will prefer the impostor — but ONLY during a real outage of the genuine agent (an impostor cannot
make itself the *only* online "echo" while the real one is connected, because presence is keyed per
fingerprint). This is a pre-existing TOFU property the change makes more deterministic in that
narrow window; the spec records it and leaves room for a future `verified`-fingerprint tiebreak.
Not closed here by design.

---

## 3. Level-of-abstraction fit

**Is this at the right layer?**

Yes — and this is the headline correction from convergence. v1 of the spec put the fix at the
relay's `RegistryStore.search()` ORDER BY, which is OFF the instar send path (the client ingests
discovery into a fingerprint-keyed Map and resolves locally). The fix belongs in the client
resolver — the lowest layer that actually decides name → fingerprint for a send — and it CONSUMES
a signal the relay already produces (live `status`) rather than re-implementing liveness. No new
parallel gate; it feeds off existing infrastructure.

---

## 4. Signal vs authority compliance

**Required reference:** docs/signal-vs-authority.md

- [x] No — this change produces/consumes a selection signal; it has no brittle blocking authority.

The change is a *selection preference* (prefer the live registration). It never silently picks
among multiple live registrations — it surfaces the existing ambiguity throw for the operator/caller
to disambiguate. No message is blocked, dropped, or rewritten. Liveness is sourced from the relay's
live-presence-derived `status`, not a brittle local heuristic.

---

## 5. Interactions

- **Shadowing:** the online-preference runs *before* the existing ambiguity throw in
  `findAgentByName`; it does not shadow the throw — it narrows when the throw fires (only ≥2 online,
  or >1 all-offline). The `fingerprintPrefix` (`name:fingerprint`) path still wins ahead of both,
  unchanged.
- **Double-fire:** the offline re-discovery is gated by a per-name 30s cooldown
  (`lastRediscoverByName`), so a burst of sends to an offline target cannot re-query the relay
  repeatedly; the existing cache-miss re-discovery path is unchanged (not cooldown-gated).
- **Races:** `discover()` now registers an `error` listener alongside `discover-result`; both share
  a `settled` guard + `cleanup()` so a late frame after either fires is a no-op. The error listener
  filters strictly on `code === RATE_LIMITED`, so an unrelated error frame (e.g. a concurrent send's
  `RECIPIENT_OFFLINE`) cannot spuriously resolve discovery (unit-tested).
- **Feedback loops:** none — discovery output feeds resolution, not back into discovery (the
  cooldown bounds the one re-query).

---

## 6. External surfaces

- **Other agents:** the merge-not-replace fix actually PREVENTS a latent regression — a keyless
  discovery frame no longer strips a peer's cached crypto keys, so E2E `send()` to a
  previously-keyed peer is not downgraded to plaintext. Name-resolved sends to freshly-discovered
  peers continue to use the relay plaintext-authenticated path (transport TLS + Ed25519), unchanged.
- **External systems:** none. No relay deploy (the relay already sends live status). No HTTP route
  added or changed. No config knob, no dashboard surface, no CLAUDE.md template change (transparent
  correctness fix).
- **Persistent state:** none — `knownAgents` and `lastRediscoverByName` are process-local, never
  persisted. No DB/ledger/migration.
- **Timing:** the offline re-discovery adds at most one discovery round-trip (≤ the 10s discover
  timeout, and fails fast on rate-limit) per resolve when the cached match is offline and the
  cooldown allows.

---

## 7. Rollback cost

Pure client-side code change in one file. Rollback = revert the PR; `findAgentByName`/`resolveAgent`
return to throw-on-ambiguity / cache-hit behavior. No persistent state, no data migration, no agent
state repair. Reaches the fleet on the next server/session restart after auto-update activates (the
in-memory cache self-heals on restart). No user-visible regression during the rollback window.

---

## Conclusion

The review produced no design changes beyond what convergence already folded in. The change is a
narrowly-scoped, single-file client resolver fix that consumes an existing relay signal, never
silently picks among live registrations, and carries a comprehensive on-path test suite (17 unit +
1 relay-backed e2e, all green; 1693 existing threadline tests unaffected; typecheck clean). High-risk
classification (name→fingerprint dispatch resolution) triggers the Phase-5 second-pass review below.

---

## Second-pass review (if required)

**Reviewer:** independent reviewer subagent
**Independent read of the artifact: concur**

Audited the actual implementation against the spec, both test files, the relay wire contract
(`relay/types.ts`), and the route callsite (`routes.ts:17500-17626`). Confirmed grounded in code:
the merge provably retains `publicKey`/`x25519PublicKey` (keyless frame → `??` keeps existing);
`pickSingleOnline` returns the single online match and the ambiguity throw fires for ≥2-online in
BOTH the exact and partial branches; `resolveAgent` re-discovers only on an offline match, returns
the offline fingerprint when still offline (no 404), and propagates the ambiguity throw (caught at
the route as a 500 with disambiguation guidance); `discover()` early-resolves only on
`code===RATE_LIMITED`. Four findings, all MINOR: the `online===undefined` case (now covered by added
tests), a `status`-absent frame mapping to `online:false` (harmless — `status` is non-optional on the
wire), a vestigial `status` property on the stored object (no consumer reads it), and an artifact
test-count miscount (now corrected to 17). No over-block, no authority creep, no external-surface
change. Clear to ship.
