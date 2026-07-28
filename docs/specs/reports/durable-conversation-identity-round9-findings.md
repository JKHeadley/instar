# Round-9 convergence findings — durable-conversation-identity

**Spec reviewed:** `docs/specs/durable-conversation-identity.md` @ commit `307ffd8a9`
("round-9 revision — resolve round-8 findings (0 CRITICAL + 1 MAJOR + 2 MINOR + 3 LOW)").
**Report commit:** this file.
**Round-9 status: NOT CONVERGED.** 0 CRITICAL + 1 MAJOR + 1 MINOR + 3 LOW.

Round 9 verified that **all six Round-8 findings (1 MAJOR + 2 MINOR + 3 LOW) are genuinely
resolved in the body as designed** — every claimed mechanism traced to every normative site:
the R8-M1 lane-scoped boot conversion (§3.4 record framing's `lane` field with append-time
funnel provenance + §5.0(a)'s lane-resolved boot rule + the retry-direction analysis + the
accepted one-duplicate residual + FD-18 + the frontmatter + the §10 content-hash crash and
bounded-duplicate-residual shapes); the R8-minor-1 verbatim encoding restatement
(`<commitmentId>:<sendSeq>` + the never-contains-`|` delimiter clause); the R8-minor-2
anchor drop + unknown-op replay rule (skip-preserve-alert, HALT reserved for storage lies,
prune exemption); and the three R8 LOWs (§9 re-enable cross-ref; the future-caller
retirement-events rule; the deploy-stamp clock anchor). BOTH externals independently endorsed
the R8-M1 fold — pi walked all five crash sub-shapes itself (content-hash pre-accept →
retry delivers; content-hash post-accept → one visible duplicate; beacon shapes unchanged;
append-time provenance consistent; replay-append idempotent-once-present), and gemini
verified the same five plus the minor/low sites.

The round's findings sit ENTIRELY on seams of the round-9 machinery itself — the same
digest-your-own-repairs signature as rounds 7 and 8. The registry core (merge algebra,
ingest normalization, boot composition, binding overlay) is finding-free for the third
consecutive round.

---

## Reviewers who ran this round

**Internal pass (one consolidated multi-lens review by the folding agent, run against the
committed revision; nothing was folded pre-external — both externals reviewed exactly the
committed `307ffd8a9` text):** adversarial, crash/replay-composition, fail-direction,
decision-completeness, lessons-aware perspectives. Confirmed the external MAJOR by
independent re-derivation (including the watermark-vs-prune interaction analysis that picks
the fix), reconciled the shared external missing-lane finding to MINOR with reasoning inline
(and REVERSED gemini's proposed default direction with a fail-direction argument), and
contributed one LOW.

**External cross-model passes (one bounded pass each), both EXECUTED by this session against
the committed spec file in the conversation-identity worktree, immediately after the
307ffd8a9 revision commit:**
- **pi / openai-codex provider, `--model openai-codex/gpt-5.5`, `--no-session --no-tools
  -p`, spec inlined** — RAN (exit 0; a first attempt with the un-prefixed `--model gpt-5.5`
  failed on a provider-resolution error — pi resolved the bare name to an unauthenticated
  azure provider — and was re-run provider-prefixed; the failed attempt produced no review
  output). Verdict line: `VERDICT: 0 CRITICAL + 2 MAJOR + 0 MINOR + 1 LOW`. It explicitly
  verified the R8-M1 crash walks itself. Its first MAJOR is reconciled to MINOR-1 below
  (shared with gemini's finding 1); its second MAJOR is confirmed by internal re-derivation
  as R9-M1; its LOW is confirmed as LOW-1.
- **gemini-cli, `-o json -m gemini-2.5-pro`, spec on stdin** — RAN (exit 0; 2 API requests,
  250.6 s total latency). Serving model captured from the run's own stats block (the
  round-6 lesson): **gemini-2.5-pro** (95,657 prompt tokens; no auxiliary model in the
  stats). Verdict line: `VERDICT: 0 CRITICAL + 0 MAJOR + 1 MINOR + 1 LOW`. It explicitly
  verified all six R8 resolutions landed. Its MINOR is the same finding as pi's first MAJOR
  (MINOR-1 below — the two externals CONVERGED on the same seam this round, the first
  overlap of the ceremony); its LOW is confirmed as LOW-2.
- **codex-cli** — NOT RUN: `codex` is not installed on this machine (same honest state as
  rounds 3–8).

---

## MAJOR findings (blocking)

1. **The unknown-op preservation guarantee is defeated by the snapshot watermark — a
   preserved newer-version record may NEVER replay after re-upgrade** `[pi-ext #2;
   CONFIRMED by internal re-derivation]`. §3.4's new unknown-op rule promises "a later
   re-upgrade replays the preserved line and loses nothing," but replay is bounded to
   `seq > snapshotHighWaterSeq`, and nothing stops the rolled-back version from advancing
   the watermark past the skipped record. Walk: version N+1 writes a new op at seq 100 →
   rollback to this version → replay skips-and-preserves seq 100 → later known records
   (seq 101…120) apply and a snapshot persists with high-water ≥ 120 → re-upgrade to N+1 →
   replay starts above 120 → the preserved seq-100 line is on disk but never applied. The
   prune exemption alone preserves BYTES, not APPLICATION. Fix (pin-level, rides existing
   machinery): the snapshot's `snapshotHighWaterSeq` NEVER advances past
   `lowestUnappliedUnknownOpSeq − 1` while any unknown-op record remains unapplied — the
   snapshot cannot claim to supersede a record it could not incorporate (the same principle
   the prune rule already states). Consequences, all safe: the interleaved known records
   above the held watermark re-apply on every boot (replay is idempotent by pinned
   contract); the prune exemption becomes AUTOMATIC (files holding records above the
   watermark are never fully-superseded — keep the explicit exemption sentence as a
   restatement); on re-upgrade the new version's tail replay starts below the unknown
   record and applies it in correct global seq order (order-correctness for free — no
   out-of-order application of a record whose semantics may be order-dependent). Honesty
   clause required: while unknown ops remain unapplied the watermark is held, so journal
   retention and boot-replay work GROW for the duration of the rollback stay — bounded
   operationally by the deduped attention item (which must name the held watermark), and
   inherently temporary (resolved by re-upgrade). §10 pins the shape: write op at seq 100
   as "future version" → rollback-replay skips it → apply + snapshot later records →
   assert high-water held at 99 → re-upgrade → assert seq 100 applies.

## MINOR findings (polish — batch)

1. **A `send-intent` record MISSING the `lane` field has no defined replay treatment**
   `[pi-ext #1 — classed MAJOR there; gemini-ext #1 — classed MINOR there, the ceremony's
   first two-external overlap; reconciled to MINOR: both externals' walks require "a
   pre-R9 server" that wrote lane-less `send-intent` records, and no such server can exist
   — the entire §5.0(a) E1 machinery is UNBUILT (this spec converges before any build), so
   the `lane` field ships in the FIRST implementation that ever writes `op:"send-intent"`;
   there is no deployed journal at any version containing a lane-less intent. The residual
   is the malformed-record case (framing corruption, hand-edit), which deserves a pinned
   rule — the same defensive-completeness class as R7-minor-3]`. Fix: a parseable
   `send-intent` record missing `lane` resolves toward RETRY (the content-hash treatment)
   + ONE deduped attention item naming the malformed record. Direction argument (REVERSES
   gemini's proposed default-to-logical): the writer is unknown, so pick by wrong-guess
   cost — defaulting logical on a notice's record silently loses the notice (the exact
   R8-M1 class); defaulting content-hash on a beacon's record costs at most one unguarded
   re-fire → one visible duplicate heartbeat, superseded by the next cadence tick.
   Loss-is-never-silent picks retry.

## LOW findings (cosmetic — batch)

1. Appendix A's provenance map stops at `R7-` → Appendix G; the body now carries `R8-*`
   tags resolved by Appendix H. Add the mapping sentence. `[pi-ext #3]`
2. `state/conversation-registry-deploy.json` (the R8-low-3 grace-clock anchor) is not in
   the §3.4 backup manifest — a disaster restore recreates it and silently RESETS the
   14-day token-less grace clock, extending the legacy security window. Add the stamp to
   the manifest (it is one tiny JSON file; the manifest already carries the snapshot +
   journal globs). `[gemini-ext #2]`
3. §5.0(a) says "boot replay appends the SAME resolution record" for a content-hash
   last-word intent but does not say WHEN relative to replay composition — a naive
   mid-replay append mutates the journal being read and participates in the same pass's
   last-word determination. Pin: the conversion appends are staged and written AFTER
   replay composes (post-compose, before serving), which also keeps replay's input
   byte-stable under the idempotency contract. `[internal]`

---

## Convergence recommendation

**NOT CONVERGED.**

Blocking: 1 MAJOR — the watermark/unknown-op composition (R9-M1), with a one-bullet
watermark-floor fix whose every consequence rides already-pinned machinery (idempotent
replay, the prune rule's own principle, global-seq-order application). Zero CRITICAL for
the fourth consecutive round; the registry core finding-free for the third; and the two
externals overlapped on a finding for the first time in the ceremony (both attacked the
lane seam — and BOTH endorsed the R8-M1 fold itself before finding it).

What is genuinely settled and should NOT be re-litigated next round: everything the round-8
report's settled list carries; all six R8 resolutions verified landed by both externals
(the lane-scoped conversion's five crash sub-shapes walked by both); the retry fail
direction for a crash-orphaned one-off notice and its one-visible-duplicate residual; the
unknown-op skip-preserve-alert rule ITSELF (only its watermark composition is open); the
anchor drop; the verbatim encoding restatement.

Recommended next step: a round-10 revision addressing R9-M1 (+ the MINOR and three LOWs —
all pin-level edits to §3.4/§5.0(a)/§7/Appendix A), then Round 10. Nothing here changes
architecture; R9-M1 changes behavior only in the rollback-with-newer-journal regime.

**Verdict: NOT CONVERGED** (0 CRITICAL + 1 MAJOR remaining; converged requires zero MAJOR).
