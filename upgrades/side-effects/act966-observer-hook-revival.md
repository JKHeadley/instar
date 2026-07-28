# Side-Effects Review — Verify-Before-Done observer hook was 100% inert (ACT-966)

**Version / slug:** `act966-observer-hook-revival`
**Date:** `2026-07-25`
**Author:** `Echo (instar-dev agent)`
**Second-pass reviewer:** `not required`

## Summary of the change

The `completion-claim-observe` Stop hook has never recorded a single hook-originated observation. Two independent defects, each sufficient on its own to kill it, and both silent by construction — the hook's `catch` exits 0, so a total failure is indistinguishable from "nothing to report".

1. **`uuidv7()` threw on every invocation.** The function sits at MODULE scope while `const crypto = await import('node:crypto')` lives inside the stdin `'end'` callback, so a bare `crypto` resolved to the global WebCrypto object — which has `getRandomValues` but not `randomBytes`. Critically, `uuidv7()` is called *inside the fetch body construction*, so the throw happened **while building the POST**: the request was never sent.
2. **The transcript guard hardcoded `~/.claude/projects`.** An agent running with a custom `CLAUDE_CONFIG_DIR` (this one uses `~/.claude-followme-adriana`) keeps transcripts under *that* directory, so every transcript failed the containment check and the hook exited 0 before doing anything.

Fixes: `uuidv7()` now uses `globalThis.crypto.getRandomValues` (no import, identical under ESM and CJS) with manual hex formatting; the transcript guard accepts the `CLAUDE_CONFIG_DIR`-derived projects root **and** the default one.

This unblocks EVO-005, whose parent spec requires measured soak data that could not exist while the observer was inert.

## Decision-point inventory

- `completion-claim-observe` Stop hook — **modify** — signal-only observer. It has no authority: it never blocks, delays, or rewrites a turn, and every path ends in `process.exit(0)`.
- Transcript containment guard — **modify** — a safety boundary on what the hook may READ. Widened from one Claude projects root to two, both still Claude projects trees.
- `tests/unit/completion-claim-observe-uuidv7.test.ts` — **add** — CI regression test, build-time only.

---

## 1. Over-block

The containment guard is the only rejecting surface, and this change makes it reject **less**: it previously rejected every transcript on any agent with a custom config dir — a 100% false-reject that was the entire second defect.

Residual over-block: an agent whose transcripts live somewhere that is neither `$CLAUDE_CONFIG_DIR/projects` nor `~/.claude/projects` is still rejected. That is intended containment, not an accident.

---

## 2. Under-block

This is the important direction, since the guard governs what the hook may read.

- **The guard is widened, so it accepts more paths than before.** Concretely it now also accepts anything under `$CLAUDE_CONFIG_DIR/projects`. `CLAUDE_CONFIG_DIR` is set by the Claude Code host, not by transcript content or hook input, so this is not attacker-controlled from the message side. An actor who can already set that env var for the hook process can run arbitrary code as that process anyway — so it grants no new capability.
- Both roots are `path.resolve`d and matched with an explicit `root + path.sep` prefix check, so `~/.claude/projects-evil` does not satisfy the `~/.claude/projects` root. Traversal (`../`) is normalised by `resolve` before comparison.
- Unchanged and still true: the hook sends **structural metadata only** — never the transcript path, commands, tool results, or raw inputs. Widening which transcript it may read does not widen what it transmits.
- Still missed: the hook does not verify the transcript belongs to the *current* session, only that it sits in a Claude projects tree. Pre-existing, unchanged by this fix.

---

## 3. Level-of-abstraction fit

Both fixes sit at the defect's own level — a scope bug fixed in the function that had it, and a path assumption fixed in the guard that made it. Neither is worked around at a higher layer.

`getRandomValues` over re-importing `node:crypto` inside `uuidv7()` is deliberate: an import inside the function would work, but it re-creates the ESM/CJS coupling that the 2026 `hook-event-reporter` incident already burned us on (a CJS-only hook broke on an ESM host). The global needs no import and behaves identically under both, so the trap cannot return by a different door.

---

## 4. Signal vs authority compliance

**Required reference:** [docs/signal-vs-authority.md](../../docs/signal-vs-authority.md)

- [x] No — this change produces a signal consumed by an existing smart gate.

The hook is the observe-only arm of Verify-Before-Done. It records observations for later analysis and holds no blocking authority; the change restores its ability to emit a signal, and grants it nothing else. The added test is CI-only.

---

## 4b. Judgment-point check (Judgment Within Floors standard)

**No new static heuristic at a competing-signals decision point.** "Is this path inside an allowed root?" is a containment invariant over a finite enumerated set of roots — deterministic by design, and a safety guard on a read boundary. No competing live signals are weighed.

---

## 5. Interactions

- **Shadowing:** none. The hook is one of several Stop hooks and does not gate the others; it exits 0 unconditionally.
- **Double-fire:** the hook may now post where it previously always failed, so observation volume goes from zero to non-zero. The server-side pass is already bounded (a single evaluation per authored response) and ships in dryRun, so this is the intended volume, not a duplicate.
- **Races:** the POST is fire-and-forget (`void fetch(...)`) followed by `process.exit(0)`. If the process exits before the request flushes, the observation is lost. **Pre-existing and unchanged** — observed during verification when a piped invocation terminated early. Not addressed here because changing exit semantics of a Stop hook is a separate behavioural change with its own review surface; noted so it is not mistaken for a new defect.
- **Feedback loops:** observations feed the Verify-Before-Done analysis, which is exactly what EVO-005 needs. Nothing feeds back into the hook.
- **Migration parity:** built-in hooks under `.instar/hooks/instar/` are **always overwritten** on every migration run (`PostUpdateMigrator` writes this file unconditionally), so deployed agents receive the fix on their next update with no additional migration. Verified at the writing callsite.

---

## 6. External surfaces

- **Other users of the install base:** every agent with the feature enabled starts producing observations where it produced none. Volume is bounded per authored response and the pipeline ships in dryRun.
- **External systems:** none — the POST is to `127.0.0.1`.
- **Persistent state:** observation records begin accumulating in the existing audit store. That store already existed and already had records from direct API calls; this only restores the hook-originated path.
- **Privacy:** unchanged. Structural metadata only; no transcript content, path, or command text is transmitted. Verified by reading the payload construction.
- **Operator surface:** none added or touched.

---

## 6b. Operator-surface quality (Operator-Surface Quality standard)

**No operator surface — not applicable.** No dashboard renderer, approval page, or grant/secret form is touched.

---

## 7. Multi-machine posture (Cross-Machine Coherence)

**Machine-local BY DESIGN.** The hook observes the turns of the session running on *this* machine, reading that machine's transcript files and posting to that machine's own `127.0.0.1` server. Transcripts are inherently machine-local artifacts, and `CLAUDE_CONFIG_DIR` is a per-machine environment fact — the whole point of fix #2 is that this path legitimately differs per machine. Replicating observations would be wrong at the emit layer; any pool-wide view belongs to the analysis surface, not the hook.

- **User-facing notices:** none. The hook is silent by design.
- **Durable state on topic transfer:** none held by the hook.
- **Generated URLs:** none.

---

## 8. Rollback cost

- **Hot-fix release:** revert; agents pick up the reverted hook on their next update via the always-overwrite path.
- **Data migration:** none. Observation records already accumulate from other paths.
- **Agent state repair:** none.
- **User visibility during rollback:** reverting restores silent inertness — no crash, no user-visible regression. Same benign asymmetry as the other fixes in this family.

---

## Conclusion

The review's substantive finding is that fixing the reported cause alone would have produced a **false fix**. ACT-966 named the `uuidv7` scope bug, and that diagnosis was correct — but on this very agent the transcript guard would still have rejected every transcript, so the observer would have stayed at zero observations while the ticket read "fixed". That is the exact proxy-signal failure the EVO-004/005/006 family exists to stop, and it was caught only by running the real hook against a real transcript instead of trusting the ticket.

Verification was deliberately made noise-free: pointing the hook at a listener under my control (via a temp project dir whose `config.json` names that port) isolated the test from concurrent background writes to the live audit store, which had been moving on their own and made a naive before/after count meaningless. Against that listener the old hook produces **zero** requests and the new one produces exactly one 623-byte POST to `/completion-claim/observe`.

The change is clear to ship. One honest limit: that A/B demonstrates old-fails/new-works but does not isolate the two fixes from each other, because the transcript used only passes the new path guard. They were verified independently — the scope bug by executing the extracted function at module scope under both ESM and CJS, the path bug by confirming the live `CLAUDE_CONFIG_DIR` value and the actual transcript locations.

---

## Second-pass review (if required)

**Reviewer:** not required.

Phase 5 triggers on block/allow decisions over messaging or dispatch, session lifecycle, context/compaction, coherence gates, trust levels, or sentinel/guard/watchdog components. This hook is an observe-only recorder that cannot block, delay, or alter a turn. It does touch a containment *guard*, but that guard governs which local file the hook may read, not any agent action — and the change to it is a widening from one Claude projects root to two, analysed in §2.

---

## Evidence pointers

- **Isolated A/B (noise-free):** with the hook pointed at a controlled listener, the pre-fix hook produced `[]` and the post-fix hook produced `[{"url":"/completion-claim/observe","bytes":623}]`.
- **Why the old hook could not post:** `uuidv7()` is invoked inside the `fetch` body argument, so the `TypeError` fired while constructing the request — the POST was never issued. Confirmed by character-offset ordering in the generated hook.
- **Scope bug reproduced:** the extracted `uuidv7` run at module scope in a real node process throws `TypeError: crypto.randomBytes is not a function` pre-fix; post-fix it returns a valid UUIDv7 (version nibble `7`, variant `8|9|a|b`, unique, time-ordered) under both `.js` and `.mjs`.
- **Path bug confirmed:** `CLAUDE_CONFIG_DIR=/Users/justin_instar_1/.claude-followme-adriana`; this agent's transcripts live under that tree, never under `~/.claude/projects`.
- **Regression test bites:** run against the pre-fix migrator, 4 of 6 tests fail with the production error; all 6 pass post-fix.
- `tsc --noEmit` clean.

---

## Class-Closure Declaration (display-only mirror)

- **`defectClass`** — `proxy-signal-substitution` (same family as PRs #1636/#1637): "the hook is installed and exits 0" was treated as evidence the observer worked, when the terminal state is "an observation was recorded".
- **`closure`** — `guard`.
- **`guardEvidence`** — `{enforcementType: ratchet, citation: tests/unit/completion-claim-observe-uuidv7.test.ts#"produces a valid UUIDv7 when run as a CJS file" + #"honours CLAUDE_CONFIG_DIR when confining transcript reads", howCaught: the test extracts uuidv7 from the REAL generated hook and executes it at module scope in a separate node process under both ESM and CJS, reproducing the exact TypeError pre-fix, and asserts the transcript guard consults CLAUDE_CONFIG_DIR while retaining the default root — so neither cause can silently return}`.
- **`gap`** — none for these two causes. The fire-and-forget POST race noted in §5 is pre-existing and out of scope; it is described there rather than claimed as closed.
