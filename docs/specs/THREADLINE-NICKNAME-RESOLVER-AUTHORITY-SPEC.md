---
title: "Threadline name-resolver honors user-curated nicknames as authority"
slug: "threadline-nickname-resolver-authority"
author: "Echo"
status: "Approved"
review-convergence: "2026-05-08T20:46:30Z"
review-iterations: 3
review-completed-at: "2026-05-08T20:46:30Z"
review-report: "docs/specs/reports/threadline-nickname-resolver-authority-convergence.md"
approved: true
approved-by: "Justin"
approved-at: "2026-05-09T09:28:03Z"
---

# Threadline name-resolver honors user-curated nicknames as authority

## Problem statement

The MCP `threadline_send` tool's name → fingerprint resolver consults only the relay's discovery cache via `ThreadlineClient.resolveAgent()`. That resolver returns the first agent in its cache whose name matches the requested string (case-insensitive). When the relay's directory holds a stale entry, an imposter, or simply the wrong instance for a name, the resolver silently returns that wrong fingerprint. The `/threadline/relay-send` route then encrypts and delivers the message to that wrong recipient.

The user maintains a hand-curated map at `.instar/threadline/nicknames.json` that records `fingerprint → user-chosen display name`. No source-tree code on `main` reads that file for outbound sends. The mapping exists for dashboard observability only.

**Real-world failure (2026-05-08, this agent's own):** Echo sent two follow-up messages to "Dawn" on Threadline thread `thread-2ebce60b`. The MCP resolver returned fingerprint `5c338c63cd2ecebc8f52483d5bba6486` for the name "Dawn"; Dawn's real fingerprint per Echo's nicknames.json (and per every prior message in that thread) is `8c7928aa9f04fbda947172a2f9b2d81a`. The messages were silently delivered to a wrong/stale recipient. The bug surfaced only because the user noticed the silence — there is no signal in the existing pipeline that this happened.

The failure mode is invisible from inside the agent: the relay accepts the encrypted envelope, returns success, the canonical outbox records "relay-sent" with the requested `recipientName`, and the local agent has no way to know the message reached the wrong endpoint. The only feedback channel is the human noticing that the recipient never replied.

## Proposed design

User-curated nicknames are the highest-authority mapping for outbound sends. Relay discovery is a signal that the resolver consults only when the user has not nicknamed the target.

### 1. Bring `ThreadlineNicknames` onto `main`

The `ThreadlineNicknames` class (originally implemented on `feat/dashboard-grouped-nav`, commit `16c605ce`) is cherry-picked onto `main` and hardened in two small ways during convergence review:

- **Atomic writes via temp+rename.** `persist()` writes to a `${file}.tmp-${pid}-${ts}` sibling and `rename(2)`s into place. Prevents a concurrent dashboard reader from observing a half-written file (which would parse-fail and degrade to "no nicknames" — a silent authority loss). POSIX guarantees rename atomicity when source and destination are on the same filesystem; `.instar/threadline/` always satisfies that.
- **30-second internal read cache** with manual `invalidate()`. Note: this cache is *instance-local*. The send route currently instantiates a fresh `ThreadlineNicknames` per request, so on the relay-send hot path this cache does NOT amortize across requests — every send pays one `fs.readFileSync` of a small JSON file. This is an explicit, accepted cost for v1: the file is small (≤ a few KB in realistic use), the route is low-volume (interactive MCP send, not a fan-out fanin path), and the simplicity of a per-request instance avoids singleton-lifecycle complexity. If profiling later shows this read on a hotter path, the route can hold a process-level singleton; the class is already shaped for that.
- **Corrupt-file tolerance with observability.** `load()` catches JSON parse errors, emits a one-shot warn (see §4), and returns an empty map. Sends fall back to relay-discovery; the corruption is visible in operator logs without spamming.

Methods: `get(fingerprint)`, `all()`, `set(fingerprint, nickname, source)`, `delete(fingerprint)`, `invalidate()`, plus the static `canonicalizeName(name)` (see §2 below).

The class is structured to be reused by the dashboard PR when that lands; the cherry-pick avoids duplicate file content.

### 2. Add a reverse-lookup method with canonicalization

`resolveByName(name): { fingerprint, entry } | { ambiguous: true, candidates } | null`

Match is by **canonicalized** equality, not naive `toLowerCase()`. The static helper `ThreadlineNicknames.canonicalizeName(name)` applies, in order:

1. **Unicode NFC normalization** — collapses combining-character forms so "é" (precomposed U+00E9) and "é" (e + U+0301) compare equal.
2. **Trim** surrounding whitespace.
3. **Collapse internal whitespace runs** to a single space — so a hand-edited "Dawn  Q " (double internal space, trailing space) resolves the same as "dawn q".
4. **Lowercase** for case-insensitivity.

Both the lookup key and the stored entry's nickname are canonicalized **at compare time**, so a `nicknames.json` edited by hand (or written by a future tool that doesn't normalize) still resolves correctly. Note that `set()` does NOT pre-canonicalize on store — the stored string preserves the user's chosen casing and spacing for the dashboard's display purposes; only the comparison is canonical. This means a user who writes `Dawn` and another who writes `DAWN  ` for different fingerprints will still trigger the ambiguous-mapping path (canonical-equal), and the dashboard will show their chosen forms verbatim.

Returns `null` when canonicalized input is empty (covers empty string, whitespace-only, and `null`/`undefined`). Returns the single match when one fingerprint maps to the canonical name. Returns `{ ambiguous: true, candidates }` when two or more fingerprints share the canonical name (the file allows it; `set()` is keyed by fingerprint, not name).

**What canonicalization does NOT cover:** confusables/homoglyphs (Cyrillic "а" vs. Latin "a"). A user who deliberately enters a homoglyph nickname will get a distinct authority entry — and that's acceptable, because nicknames are user-curated; if the user wrote it, they meant it. A homoglyph-detection step would belong in a future Haiku-driven nickname review on `set()`, out of scope for this fix.

### 3. Wire into `/threadline/relay-send`

At the top of the route handler, after request validation:

```
if (!looksLikeFingerprint(targetAgent)) {
  const fpPrefixParse = parseNameFpPrefix(targetAgent);  // {name, fpPrefix} | null
  const lookupName = fpPrefixParse ? fpPrefixParse.name : targetAgent;
  const lookup = nicknameStore.resolveByName(lookupName);
  // Three cases:
  // (a) lookup is null → no nickname; existing relay-discovery path runs.
  // (b) lookup is single → nicknameResolvedFp = lookup.fingerprint, UNLESS
  //     fpPrefixParse is set and its prefix disagrees with the curated fp,
  //     in which case the caller's prefix wins (warn-logged).
  // (c) lookup is ambiguous → if fpPrefixParse is set, filter candidates by
  //     prefix: exactly-one → use it; zero → 409 with candidate list; many
  //     → 409 asking for a longer prefix. If fpPrefixParse is null → 409
  //     with the bare candidate list.
}
```

`looksLikeFingerprint` matches `/^[0-9a-f]{16,64}$/i`. The `name:fpPrefix` qualifier is a `:`-suffix that is 4–32 hex chars. The nickname lookup runs even when the qualifier is present so that the documented disambiguation remedy actually disambiguates among nickname candidates (the original draft skipped nickname lookup whenever `:fpPrefix` was present, which made the spec's prescribed remedy a dead end — corrected during convergence review).

`nicknameResolvedFp` is then propagated through the existing flow:

- **Local-delivery match** (against `known-agents.json`): when set, filter agents by fingerprint instead of by name. Same-name local agents are bypassed in favor of the user's curated mapping; if the nickname's fingerprint matches a local agent, local delivery still happens, just routed by fingerprint.
- **Relay-delivery resolver**: when set, use it directly as `resolvedId`, skipping `relayClient.resolveAgent`. As a probe, still call `resolveAgent` and log a `[relay-send] Nickname/discovery mismatch …` warning when discovery returns a different fingerprint for the same name; the route honors the nickname regardless.

### 4. Failure modes and their handling

- **`nicknames.json` missing or empty**: `ThreadlineNicknames.load()` returns an empty map; `resolveByName` returns null; behavior is unchanged from today.
- **`nicknames.json` corrupt JSON**: `load()` catches the parse error and emits a one-shot warn `[ThreadlineNicknames] nicknames.json parse failed at <path>: <message>. Treating as empty (no user-curated authority for this load cycle). Outbound sends will fall back to relay-discovery for nicknamed names.` then returns an empty map. The warn fires at most once per cache cycle (every 30s), so a persistently-corrupt file is observable in operator logs without spamming. Sends still go through via the existing relay-discovery path. **This is a deliberate fail-soft choice**: we'd rather route via discovery (which historically worked) than 5xx on every send while a JSON syntax error is being fixed. The route's outer `try/catch` around the lookup remains as a defense-in-depth catch for any unforeseen throw from `load()` or `resolveByName()`; under normal corrupt-file behavior, only the inner `load()` warn fires.
- **Concurrent dashboard write while route reads**: atomic temp+rename in `persist()` (see §1) means the reader either sees the old file or the new file, never a half-written one. Worst case: a route request that started reading the old file just before a dashboard edit honors the old mapping; the next request (after cache TTL) honors the new one. Acceptable — there is no transactional contract between dashboard edits and in-flight sends.
- **Ambiguous nickname (two fingerprints sharing one name)**: 409 with all candidates listed (each as `nickname:fpPrefix (fullFp)`). The caller's documented remedy is to retry as `name:fpPrefix` or as a raw fingerprint. The nickname-lookup branch handles `name:fpPrefix` correctly: it parses the prefix, looks up the bare name in the nickname store, and filters the candidates by the prefix — exactly one match yields the curated fingerprint, zero matches returns 409 with the candidate list, multiple matches returns 409 asking for a longer prefix. This means the documented operator remedy is wired end-to-end (it is NOT a dead-end skip of the nickname store, which an earlier draft incorrectly described).
- **Nickname/prefix disagreement** (caller passes `name:fpPrefix` and the curated nickname's fingerprint doesn't start with that prefix): the route honors the caller's prefix and skips nickname authority for this send, with a warn `[relay-send] Nickname/prefix disagreement for <name>: nickname maps to X…, caller prefix is Y. Honoring caller prefix.` The reasoning: a caller who explicitly typed a prefix is making a more specific assertion than the curated mapping (e.g., they may know the nickname is stale and be sending to the new fingerprint). The conflict is observable.
- **Stale nickname — nickname disagrees with discovery** (relay returns a different fingerprint for the same name): mismatch warning fires (`[relay-send] Nickname/discovery mismatch …`); authority wins; send proceeds to the user-curated fingerprint. This is the canonical case the fix is designed for.
- **Stale nickname — fingerprint unreachable or unknown to relay** (discovery returns null/empty for the same name, or the fingerprint is simply offline): no mismatch warning fires (there's nothing to compare against); send proceeds to the user-curated fingerprint and fails downstream the same way an ordinary unreachable-recipient send fails today. No new observability is added in this fix for that case — the operator's signal is the existing relay-side delivery failure. **Future work:** structured "authority-routed" metadata in the canonical outbox entry would let the dashboard surface stale-fingerprint patterns; tracked separately from this spec.

### 5. Trust boundary

The authority elevation in this fix rests on one assumption: **`ctx.config.stateDir` is process-owned, locally controlled, and not derivable from any request-time input.** That assumption already holds throughout instar — `stateDir` is fixed at server-start from on-disk config, not from any HTTP body, header, or query parameter. The nickname store inherits the same trust boundary as every other `.instar/` file (jobs.json, identity.json, known-agents.json). If a future change ever lets a request influence `stateDir`, this fix's authority elevation must be re-evaluated; that's a structural invariant, not an implementation detail.

There is no remote write surface to `nicknames.json`. Today it is written by (a) hand-editing, (b) the dashboard route on the dashboard branch (which itself requires an authenticated session), and (c) a future Haiku suggester. All three operate inside the trust boundary. Nickname strings flow through the system as comparison keys and log/error fields only — they are never executed, never used as paths, never serialized into shells.

### 6. Multi-machine semantics

`nicknames.json` is **per-machine** authority. If "echo-laptop" and "echo-server" are two physical instances of the same logical agent identity, they each maintain their own `nicknames.json` and may resolve the same display name to different fingerprints. This is intentional:

- Nickname authority is a **statement of intent by the operator on that machine** — "on this machine, when I say Dawn, I mean *this* fingerprint." Two machines may legitimately disagree (e.g., one of them is mid-rekey for a peer; one has been told the new fingerprint, one hasn't).
- The alternative (a synced authoritative store) would re-introduce the gossip-style staleness this fix exists to defeat — sync delay would mean either machine could route to a wrong fingerprint while waiting for replication.
- For operators who want consistency, the existing instar git-sync of `.instar/` already replicates `nicknames.json` byte-identically across paired machines on the next sync. That's the right transport: explicit, observable, and on the operator's schedule.

The acceptance bar: a single send from a single machine routes correctly. Cross-machine consistency is an operational concern, not a correctness concern.

### 7. Local-delivery filter narrowing

When `nicknameResolvedFp` is set, the local-delivery branch filters `known-agents.json` entries by **fingerprint match** (`a.fingerprint || a.publicKey?.substring(0,32)` lowercased equality), not by name. This is intentional and tighter than the un-nicknamed path:

- If a local agent has a fingerprint and it matches the nickname, local delivery proceeds.
- If a local agent has the right name but a different fingerprint (or no fingerprint recorded), the nickname-routed send goes to the relay path instead. This is the correct outcome: the user's curated mapping says "Dawn is fingerprint X"; a local entry that calls itself "Dawn" but isn't fingerprint X is, by the user's own authoritative statement, not the right Dawn.
- A local agent missing fingerprint AND publicKey can't be matched on this branch. That's a legitimate gap in `known-agents.json`, not a bug in this resolver — it would also fail any fingerprint-based delivery elsewhere. The fix is to populate the entry's fingerprint, not to weaken the matcher.

### 8. Out of scope

- The dashboard UI for editing nicknames lives on `feat/dashboard-grouped-nav` and lands separately. This spec covers the send-path only.
- The Haiku-driven nickname suggester (also on the dashboard branch) is unrelated.
- Listener-daemon's inbound resolution is unchanged. Inbound messages already have a verified fingerprint from the encrypted envelope; no name lookup is needed.
- Local `known-agents.json` semantics are unchanged for un-nicknamed names.

## Authority/signal mapping

This change is the canonical signal-vs-authority move (per `docs/signal-vs-authority.md`), scoped precisely:

- **For nicknamed names**: `ThreadlineNicknames` is **authority** (full-context, user-curated, set explicitly by the user). `relayClient.resolveAgent(name)` becomes a **signal** in this branch — it's still called as a probe so that nickname/discovery disagreements are visible in operator logs, but the resolver does not consult it for the routing decision.
- **For un-nicknamed names**: `relayClient.resolveAgent(name)` remains the deciding resolver. The principle's "single authority per decision point" still holds — the decision point is "resolve a name the user hasn't curated," and relay discovery is the only authority instar has for that. This fix does not weaken or strengthen that path; it only carves out an authoritative override for the curated case.
- **For fingerprint inputs and `name:fpPrefix` qualifiers**: the caller has already done the disambiguation; neither nickname nor relay discovery is consulted as authority for the name half — the caller's bytes win.

The earlier framing "relay discovery becomes signal-only" was overbroad and is corrected here: relay discovery is signal-only *when nickname authority is present*, and authority *when it isn't*. That is the honest architectural story.

## Acceptance criteria

1. A send to a user-nicknamed name routes to the nickname's fingerprint, not the relay's resolved one, even when the relay returns a different (wrong) fingerprint for the same name.
2. A send to an un-nicknamed name continues to use relay discovery (no behavior change).
3. A send to a raw fingerprint (matching `^[0-9a-f]{16,64}$`) skips the nickname check entirely. A `name:fpPrefix`-qualified name does NOT skip the nickname check — it consults the store, and (a) when the nickname has multiple candidates, filters by the prefix; (b) when the nickname has a single candidate that disagrees with the prefix, honors the caller's prefix and warn-logs the disagreement; (c) when no nickname matches the bare name, falls through to relay discovery as today.
4. A corrupt `nicknames.json` does not crash sends — it falls through to relay discovery.
5. An ambiguous nickname (two fingerprints, one name) returns 409 with both candidates listed.
6. The mismatch between relay discovery and a nickname is logged at warning level when both fire.
7. Tests cover the production-bug reproduction (relay returns wrong fingerprint, nickname authority overrides).

## Rollback

Single-commit revert. The change touches `src/server/routes.ts` (additive nickname-lookup block + filter swap), adds `src/threadline/ThreadlineNicknames.ts` (new file), and adds tests + release notes. No data migration, no schema change, no deployment ordering. The `nicknames.json` file format is read-only from this route — no writes. Reverting leaves the system in a consistent state.

## Test plan

- **Unit (`tests/unit/ThreadlineNicknames.test.ts`, 8 cases)**: `resolveByName` with missing file, empty/whitespace input, single user-curated match (case-insensitive), ambiguous-mapping detection, on-disk file written outside the process, corrupt-file tolerance, no-match, **and canonicalization** (NFC + internal-whitespace-collapse — a hand-edited `"Dawn  Q "` resolves the same as `"dawn q"`).
- **Integration (`tests/integration/threadline-relay-send-nickname.test.ts`, 3 cases)**: stub relay client whose `resolveAgent('Dawn')` returns the WRONG fingerprint `5c338c63…`; `nicknames.json` curates `Dawn` → `8c7928aa…`; assert the route sends to `8c7928aa…` and the response's `resolvedAgent` field is `8c7928aa…`. Plus the no-nickname (404) and raw-fingerprint pass-through cases.
- **Push gate**: full unit suite must remain green on the threadline-area subtree (~1493 tests including the existing ThreadlineClient affinity, MCP server relay, observability, and listener tests).
