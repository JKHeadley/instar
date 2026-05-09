# Convergence Report — Threadline name-resolver honors user-curated nicknames as authority

**Spec:** `docs/specs/THREADLINE-NICKNAME-RESOLVER-AUTHORITY-SPEC.md`
**Slug:** `threadline-nickname-resolver-authority`
**Author:** Echo
**Iterations:** 3
**Verdict:** Converged

## ELI10 Overview

There's a part of Echo (and any agent on Threadline) that takes a friendly name like "Dawn" and looks up who that actually is, so it can send a message. Until now, Echo only asked the **shared address book on the relay server** — the same way you'd ask the postal service "who is Dawn?" The relay sometimes gives back the wrong person, because its address book gets stale or has duplicates with the same name. When that happens, your message goes to the wrong person, and you don't find out unless they never reply.

This fix adds a **personal address book on Echo's own machine**: `nicknames.json`. When you've personally written down "Dawn is fingerprint 8c79…", Echo trusts your note over the relay's guess. The relay is still consulted, but only as a hint that gets logged when it disagrees — not as the final answer. If you haven't named someone, nothing changes: Echo still asks the relay.

What changes for the user: messages addressed by curated nicknames now go to the right recipient even when the relay's directory is wrong. The bug Echo hit on 2026-05-08 (two messages to "Dawn" silently misrouted to fingerprint `5c33…` instead of `8c79…`) is reproduced as a regression test and verified to stop.

The main tradeoff: your personal address book lives on your machine. If you have Echo running on two laptops, they can disagree about who "Dawn" is — that's intentional. The fix optimizes for "the message you send right now, from this machine, goes to the recipient *you* meant" over "every machine routes identically." Operators who want consistency can sync `.instar/` between machines (which Echo already does via git-sync).

## Original vs Converged

The original spec was a clean, narrow description of a small bug fix: cherry-pick an existing `ThreadlineNicknames` class, add a reverse-lookup method, wire it into one route. Three rounds of review (internal angles + GPT/Gemini/Grok) tightened it in five concrete ways:

1. **Honesty about the cache.** The original spec advertised a "30-second internal read cache" as if it amortized. All three external models flagged the same issue: the route creates a fresh instance per request, so the cache is per-instance and doesn't help across requests. The converged spec acknowledges the per-request file read explicitly, justifies it (small file, low-volume route), and documents the singleton path as a future option. No false advertising.

2. **Real canonicalization, not naive lowercase.** The original used `name.trim().toLowerCase()`, which silently fails on hand-edited entries like "Dawn  Q " (double space, trailing space) or NFD-form Unicode. The converged design canonicalizes both lookup keys and stored entries at compare time using NFC + whitespace-collapse + lowercase, so visually-identical names always resolve the same. A unit test was added.

3. **Atomic writes for real.** The original spec claimed "atomic writes" but the code used a plain `writeFileSync`. A concurrent reader could observe a half-written file, parse-fail, and silently lose all nickname authority. The converged code writes to a temp file and renames, which POSIX guarantees is atomic on the same filesystem.

4. **Corrupt-file observability.** The original silently swallowed JSON parse errors. The converged version emits a one-shot warn (rate-limited by the cache cycle) so operators can see when a corrupt nicknames file is silently degrading authority — without spamming logs while the issue is being fixed.

5. **The disambiguation remedy actually works.** The original spec told ambiguous-nickname callers to retry as `name:fpPrefix`. But the route was coded to *skip the nickname check entirely* whenever `name:fpPrefix` was present — so the documented remedy didn't disambiguate among nickname candidates at all; it just punted to the relay. The converged route parses the prefix, looks up the bare name, and filters candidates accordingly (1 → use it, 0 → 409 with candidates, many → 409 asking for a longer prefix). It also handles the case where a caller's explicit prefix disagrees with a single-candidate nickname (caller wins, warn-logged).

Two further angles were validated in writing without code change:
- **Multi-machine semantics** (per-machine authority is intentional; sync via git-sync if needed).
- **Trust boundary** (`stateDir` must remain process-controlled — already a structural invariant in instar, just made explicit here).

The architecture/signal-vs-authority framing was also tightened: instead of "relay discovery becomes signal-only" (overbroad), the converged language is "for nicknamed names, nicknames are authority and relay is signal-only; for un-nicknamed names, relay remains the deciding resolver."

## Iteration Summary

| Iteration | Reviewers who flagged | Material findings | Spec/code changes |
|-----------|-----------------------|-------------------|-------------------|
| 1         | GPT, Gemini, Grok + internal | 8 | Cache honesty, multi-machine, observability gap, normalization (NFC + collapse + canonical helper), wording, trust boundary, local-delivery filter, atomic writes; new unit test for canonicalization |
| 2         | GPT (3), Gemini (1), Grok (0) | 3 | Corrupt-file warn in load(), `name:fpPrefix` disambiguation wired through nickname store, docstring fixed re: set() not pre-canonicalizing |
| 3         | GPT, Gemini, Grok all flagged the same single residual | 1 | Acceptance Criterion #3 rewritten to match new dispatcher logic for `name:fpPrefix` |
| 3+ (post-fix) | (converged) | 0 | none |

## Full Findings Catalog

### Iteration 1

| # | Severity | Reviewer(s) | Original | Resolution |
|---|----------|-------------|----------|------------|
| 1.1 | High | GPT, Gemini, Grok | Per-request `new ThreadlineNicknames()` defeats the 30s cache; spec advertised cache benefit it didn't deliver. | §1 rewritten — explicitly states per-request file read cost is accepted for v1, justifies (small file + low-volume route), documents singleton as future optimization. No false advertising. |
| 1.2 | High | Grok | `nicknames.json` is per-machine; multi-instance deployments diverge silently. | New §6 explicitly documents per-machine authority as intentional with rationale. Notes git-sync as the consistency transport. Updates acceptance bar: single-machine correctness, not cross-machine consistency. |
| 1.3 | Medium | GPT | Stale-authority observability incomplete: warning only fires when relay returns a *different* fp, not when relay is silent. | §4 rewritten to distinguish "nickname disagrees with discovery" (warn fires) vs "discovery silent" (no warn — same failure mode as ordinary unreachable-recipient). Future canonical-outbox metadata noted as out-of-scope follow-up. |
| 1.4 | Medium | GPT, Grok | `trim().toLowerCase()` misses NFC, internal whitespace, and `set()` doesn't canonicalize stored values. | New `canonicalizeName()` helper (NFC + trim + collapse-internal-whitespace + lowercase). Applied at compare time on both lookup key and stored entries. New unit test. |
| 1.5 | Medium | GPT | "Relay discovery becomes signal-only" overbroad — relay is still authority for un-nicknamed names. | "Authority/signal mapping" section rewritten: scoped per-input-type (nicknamed → authority/signal split; un-nicknamed → relay authority; fp-input/prefix → caller). |
| 1.6 | Medium | GPT | `stateDir` trust assumption is implicit but load-bearing. | New §5 explicitly states the structural invariant: `stateDir` is process-controlled, not request-derivable. Inherits trust boundary of all `.instar/` files. |
| 1.7 | Low | Grok | Local-delivery filter swap to fp-only silently drops name-only same-name agents. | New §7 documents intentional behavior: by user's curated mapping, a name-matching local agent without the right fingerprint is by definition not the right Dawn. The fix for missing fp is in `known-agents.json`, not the resolver. |
| 1.8 | Material (internal angle) | Echo (spec-vs-code audit) | Spec claimed atomic writes but `persist()` used plain `writeFileSync`. | Code changed to temp+rename (`${file}.tmp-${pid}-${ts}` then `rename()`). §1 describes the actual mechanism. |

Non-material in iter1 (noted, no change): nickname strings echoed in error/log responses are user-controlled but non-executable; resolveByName is O(n) which is fine for small n; cache TTL doesn't auto-invalidate on dashboard writes (acceptable for v1).

### Iteration 2

| # | Severity | Reviewer(s) | Original | Resolution |
|---|----------|-------------|----------|------------|
| 2.1 | Medium | GPT (twice — sec & arch) | Corrupt-file fail-open is silent: `load()` swallows the parse error, so the route's outer try/catch never fires. Operator has no signal that authority is being silently bypassed. | `load()` now emits a one-shot warn `[ThreadlineNicknames] nicknames.json parse failed at <path>: <message>. Treating as empty (no user-curated authority for this load cycle). Outbound sends will fall back to relay-discovery for nicknamed names.` Rate-limited by 30s cache cycle (no spam). §4 documents the deliberate fail-soft choice and the route's outer try/catch as defense-in-depth only. |
| 2.2 | Medium | GPT | Documented disambiguation remedy (`name:fpPrefix`) was a dead end — route skipped nickname lookup whenever `:fpPrefix` was present, so it couldn't disambiguate among nickname candidates. | Route rewritten: nickname lookup runs even for `name:fpPrefix` inputs; ambiguous candidates filtered by prefix (1 → use, 0 → 409 with candidate list, many → 409 asking longer prefix). Single-candidate-vs-prefix disagreement: caller's prefix wins, warn-logged. §3 and §4 updated. |
| 2.3 | Low | Gemini | `canonicalizeName` docstring claimed `set()` uses it for stored values, but `set()` doesn't. | Docstring rewritten to state set() deliberately does NOT pre-canonicalize on store (preserves user's display string for the dashboard); compare-time canonicalization only. §2 has matching note. |

### Iteration 3

| # | Severity | Reviewer(s) | Original | Resolution |
|---|----------|-------------|----------|------------|
| 3.1 | High (Gemini) / Medium (GPT) | GPT, Gemini, Grok all flagged the identical issue | Acceptance Criterion #3 was stale: said `name:fpPrefix` "skips the nickname check entirely," contradicting the new §3/§4 logic. A test author working from AC #3 would re-introduce the disambiguation dead end. | AC #3 rewritten to match: raw fingerprint skips the check; `name:fpPrefix` does NOT skip — it consults the store, filters ambiguous candidates by prefix, honors caller's prefix on disagreement, falls through on no nickname match. |

### Convergence

A fourth round was not run. The iteration-3 finding was a single mechanical text inconsistency that all three external models flagged identically; the fix is a one-paragraph rewrite of one acceptance criterion to align with already-converged §3/§4 semantics. There is no remaining design space to re-explore. The 3-iteration cap set by the user matches this judgment.

## Convergence verdict

Converged at iteration 3. All material findings from rounds 1–3 are addressed in spec text and (where applicable) implementation code. Tests pass: 11/11 (8 unit, 3 integration). The spec is ready for user review and approval.
