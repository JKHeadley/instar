# Round-8 convergence findings — durable-conversation-identity

**Spec reviewed:** `docs/specs/durable-conversation-identity.md` @ commit `765912f34`
("round-8 revision — resolve round-7 findings (0 CRITICAL + 3 MAJOR + 3 MINOR + 2 LOW)").
**Report commit:** this file.
**Round-8 status: NOT CONVERGED.** 0 CRITICAL + 1 MAJOR + 2 MINOR + 3 LOW.

Round 8 verified that **all 8 Round-7 findings (3 MAJOR + 3 MINOR + 2 LOW) are genuinely
resolved in the body as designed** — every claimed mechanism was traced to EVERY normative
site it touches, against the spec text, never the commit message: the R7-M1
delivered-equivalent suppression outcome (§5.0(a) intro + seq bullet + the R5-M3 ordering
bullet + the send-intent bullet's now-true supersession claim + FD-18 + the frontmatter +
the §10 un-mute shape + REFINED markers on the superseded Appendix C/F entries); the R7-M2
lane split (§5.0(a) first bullet + logical-identity bullet + §6.1 steps 5–6 + FD-18 + the
§10 lane-split shapes + the SCOPED marker on Appendix C's M1); the R7-M3 composite boot
keying (§5.0(a) intent-resolution + boot rule + §3.4 snapshot-completeness "unresolved"
definition + the §10 same-PAIR supersession clause + composite-key boot shape + FD-18). The
key walks were re-executed rather than merely read:

- **The R7-M1 un-mute walk**: ambiguous at seq 7 → entry `(C, cmt-42:7)` recorded, seq held
  at 7 → next tick re-fires logical send 7 → guard match → suppressed → the beacon
  advances+persists seq to 8 AND journals `send-retire` for the pair under the R5-M3 pinned
  order → next tick fires seq 8 → no match → posts. The mute is broken after exactly one
  suppressed heartbeat; the R6-M1 "next cadence tick supersedes" claim is now mechanical
  fact. Crash sub-windows of the suppressed fire were walked: kill between the suppression
  verdict and the seq persist → seq stays 7, entry unretired → the next fire is suppressed
  again and advances (one extra suppressed beat, self-healing, no double-post); kill between
  seq persist and retire journal → seq 8, stale entry ages out at TTL (the disclosed R5-M3
  leak). Exactly-once holds in every window. A grep sweep for residual
  held-constant-across-suppressed statements found them ONLY in the historical appendices,
  each carrying the round-8 REFINED marker (the house convention).
- **The R7-M3 composite-key boot walk**: two conversations A and B sharing one content-hash
  `logicalSendId`; A's `send-intent` unresolved by a crash, B's later `send-intent-resolved`
  present. Under the committed pair-quantified rule, B's record is the last word only for
  ITS pair — A's intent converts (re-fire suppressed), B's does not. Both failure directions
  of the round-7 single-field conflation are closed. Every stated site quantifies over the
  pair; no residual single-field statement outside marked appendix history.
- **The R7-minor-1 concurrent first-boot walk**: two machines authed to different
  workspaces, no config pin, concurrent first boot → each writes + self-confirms its own
  candidate → each mints concretely under its LOCAL teamId → on replication heal, each
  quarantines the peer's divergent candidate (loud) and the multi-machine emitter HOLD keeps
  concrete-workspace entries out of replication while no config pin exists. The retracted
  mutual-exclusion clause is gone; the containment the new text points at is real and was
  verified present at its cited sites (§3.1 fleet-wide layer + the M9 emitter hold).

Code claims new to the round-8 revision were re-verified against this worktree's real
source: `contentHashDedupWindowMs = 900000` mirrors the deployed Telegram exact-duplicate
window EXACTLY (`OutboundContentDedup.ts:43` — `windowMs: 15 * 60 * 1000`, and the recorded-
only-after-successful-send comment at `routes.ts:11264-11271` matches the spec's
characterization of the precedent). No other new code citations were introduced this round.
Zero false code claims found.

The round's one blocking finding sits — again — on §5.0(a)'s E1 machinery: the LAST unswept
composition of the R6-M1 send-intent boot conversion with the R7-M2 content-hash lane. It
is latent since R6-M1 composed with the fallback lane (the round-8 lane split NARROWED its
blast radius from 7 days to 15 minutes without deciding its fail direction). The registry
core — merge algebra, ingest normalization, boot composition, binding overlay, workspace-pin
machinery — took zero findings for the second consecutive round.

---

## Reviewers who ran this round

**Internal pass (one consolidated multi-lens review by the folding agent, run against the
committed revision; nothing was folded pre-external — both externals reviewed exactly the
committed `765912f34` text):** adversarial, integration (code-grounded — the new
`OutboundContentDedup.ts:43` mirror-value claim verified in this worktree), security,
crash/replay-composition, decision-completeness, fail-direction, lessons-aware perspectives.
Confirmed the external MAJOR by independent re-derivation (including the drain-terminality
analysis that makes it a real loss, not a delay), reconciled gemini's MAJOR to MINOR with
reasoning inline, and contributed two LOWs.

**External cross-model passes (one bounded pass each), both EXECUTED by this session against
the committed spec file in a clean worktree, immediately after the 765912f34 revision
commit:**
- **pi / openai-codex provider, `--model gpt-5.5`, `--no-session --no-tools -p`, spec
  attached via `@file`** — RAN (completed in ~4 minutes, exit 0). Verdict line:
  `VERDICT: 0 CRITICAL + 1 MAJOR + 0 MINOR + 0 LOW`. It explicitly verified all three R7
  MAJORs landed (including walking the R7-M1 crash windows itself and sweeping for residual
  single-field boot statements — none found). Its one MAJOR is confirmed by internal
  re-derivation as R8-M1 below.
- **gemini-cli, `-o json -m gemini-2.5-pro`, spec on stdin** — RAN (exit 0; single API
  request, 217 s latency). Serving model captured from the run's own stats block (the
  round-6 lesson — model self-reports are unreliable, the stats block is authoritative):
  **gemini-2.5-pro** (133,186 input tokens; no auxiliary model appeared in this run's
  stats). Verdict line: `VERDICT: 0 CRITICAL + 1 MAJOR + 1 MINOR + 1 LOW`. It explicitly
  verified all three R7 MAJORs and the minor/low fixes landed. Its MAJOR is reconciled to
  MINOR-1 with reasoning inline (never a silent downgrade); its MINOR is confirmed as
  MINOR-2 (sharpened by an internal composition observation); its LOW is confirmed as LOW-1.
- **codex-cli** — NOT RUN: `codex` is not installed on this machine (`which codex` → not
  found; same honest state as rounds 3–7).

The two externals' findings were again fully disjoint — the same single-pass-variance datum
rounds 6 and 7 recorded.

---

## Round-7 resolution verification (protocol step 1)

Every Round-7 finding traced to its claimed resolution in the round-8 body, verified against
the revised spec text:

| R7 finding | R8 resolution verdict |
|---|---|
| **M1** (the suppressed-outcome seq rule contradicted the "next cadence tick supersedes" claim — one ambiguous ack silently muted ALL beacon output for a commitment until close/7-day TTL) | **RESOLVED as designed.** `already-delivered-recently` is DELIVERED-EQUIVALENT for sequencing (§5.0(a) seq bullet): the suppressed fire advances+persists `sendSeq` and journals `send-retire` under the exact R5-M3 pinned order; "suppressed" dropped from the held-constant list (held across `not-delivered`/ambiguous only, which is all the hold's rationale ever needed); the R5-M3 ordering bullet, the intro sentence, FD-18, and the frontmatter all aligned; sequencing explicitly scoped beacon-lane-only. §10 pins the un-mute shape. The un-mute walk and both crash sub-windows re-executed (above) — exactly-once holds; the mute is structurally impossible past one cadence. Superseded appendix entries carry REFINED markers. Clean — no sibling flaw found on this fix. |
| **M2** (the content-hash fallback lane had no retirement semantics — one successful send suppressed same-text notices for the full 7-day TTL) | **RESOLVED as designed.** Lane split at the retirement definition (§5.0(a) first bullet): retirement-based suppression SCOPED to callers with a logical send identity; the content-hash lane is WINDOW-based — `contentHashDedupWindowMs = 900000` (15 min, verified byte-equal to the deployed Telegram precedent at `OutboundContentDedup.ts:43`) — never the 7-day TTL as a suppression horizon; expired entries prune like retired ones; journal/boot/composite-keying lane-identical. §6.1 steps 5–6 name the lane for their consumers; FD-18 aligned; §10 pins both lane-split directions. **Sibling seam → R8-M1** (the lane split narrowed but did not DECIDE the fail direction of the R6-M1 intent conversion for this lane — the one composition neither R7-M2 nor the fold swept). |
| **M3** (the send-intent boot rule keyed on `logicalSendId` alone vs the guard's composite key — cross-conversation supersession for content-hash callers in both directions) | **RESOLVED as designed.** The boot rule quantifies over the composite `(conversationId, logicalSendId)` PAIR everywhere it is stated: the §5.0(a) intent-resolution sentence and boot rule (with the two-direction failure construction inline), §3.4's snapshot-completeness "unresolved" definition, the §10 supersession clause (same-PAIR) + the new composite-key boot shape, FD-18. The composite-key walk re-executed (above) — both directions closed. Clean — no sibling. |
| minor-1 (rule 3's fail-closed vacuous under self-confirmation; the mutual-exclusion consequence clause false in a concurrent first-boot race) | **RESOLVED.** The clause is RETRACTED explicitly in a §3.1 scope-honesty note; rule 3's surviving guarantee restated at its real strength ("no concrete mint before any concrete LOCAL observation" + the second-machine replicated-candidate containment); the actual containment layers named and verified present (R2-security-NEW-2 corroboration gate, loud divergence quarantine + keep-minting-locally, the multi-machine emitter HOLD). The concurrent first-boot walk re-executed — the retraction is accurate and the containment holds. |
| minor-2 ("one session generation" asserted as the token-less migration bound with nothing enforcing it) | **RESOLVED.** §7 names the real bound honestly (the reaper's age-cap recycle where it applies; unbounded worst case for the reaper-exempt tail) + the observability backstop: past `tokenlessBindGraceDays = 14` days deployed, a token-less positive-id bind still succeeds but raises ONE deduped attention item naming the straggler(s); fail-open justified (today's pre-spec permissiveness closing out; minted-id binds hard-gated regardless). §10 pins the straggler-item test. **Cosmetic sibling → LOW-3** (the mechanism anchoring "deployed ≥ N days" — a migrator/first-boot version stamp — is not named). |
| minor-3 (non-tail journal corruption unpinned — a faithful "skip and continue" silently loses a committed record) | **RESOLVED.** §3.4 record-framing pins the fail-closed direction: a newline-TERMINATED line failing JSON parse during replay HALTS the replay into the §3.6 corrupt-file quarantine-aside + rebuild path (file preserved aside; §6.2 recovery order applies) + ONE deduped attention item + a durability-incident record feeding the §3.7 broadened SQLite trigger. §10 pins the halt-never-skip shape. Consistency with §3.6's fail-toward-delivery row checked: delivery still degrades to the in-memory-candidate path; only the durable replay halts. **Composition note → sharpens MINOR-2** (the §3.4 rotation "checkpoint anchor" record must be a defined op or explicitly-ignored kind, else it meets this new strictness undefined). |
| low-1 (§10 suite-summary line still labeled the coherence branch "INCOHERENT-pair fallback") | **RESOLVED.** Relabeled "incoherent-pair REFUSAL" with the R7-low-1 marker; the full §3.5.2 suite paragraph it defers to was verified to assert the refusal (zero deliveries + re-arm + dead-letter). |
| low-2 (the §3.5 ingest-refusal aggregation enumeration omitted `key-tuple-mismatch`) | **RESOLVED.** Added to the aggregator's class inventory with the R7-low-2 marker — the list is again the complete inventory it reads as. |

**Net:** zero round-7 findings regressed; all eight landed as designed. The R7-M2 resolution
carries one sibling seam on the machinery it scoped (→ R8-M1, the intent-conversion fail
direction for the lane it created), and two resolutions carry cosmetic siblings (minor-2 →
LOW-3, minor-3 → the MINOR-2 sharpening) — the same digest-your-own-repairs signature as
rounds 6 and 7, now down to ONE blocking item.

---

## CRITICAL findings

**None.** The third consecutive zero-CRITICAL round.

---

## MAJOR findings (should change the spec)

### R8-M1 — the send-intent boot conversion is lane-agnostic, but its fail direction only makes sense for the beacon lane: a one-off notice that NEVER reached Slack can have its retry suppressed as `already-delivered-recently` and be silently lost, with the audit claiming delivery
**§5.0(a) (send-intent bullet boot rule × the R7-M2 content-hash lane), §6.1 steps 5–6, §10**
· `[pi-gpt-ext #1; internally confirmed]`

The walk: (1) a content-hash caller — a reap notice or attention item, exactly the §6.1
step-5/6 consumers — sends notice N to conversation C; `logicalSendId = hash(N)`. (2) The
funnel appends+fsyncs `op:"send-intent" { C, hash(N) }` — the intent is written for EVERY
`id<0` guarded send, both lanes. (3) The process dies BEFORE the transport request is issued
(or before Slack accepts it) — the message never posted. (4) At boot, the intent is the last
word for its pair → it converts into an `ambiguous-send` entry ("the honest classification,
since the outcome is genuinely unknown"). (5) The durable notice drain retries N within the
15-minute window → the guard suppresses it → the typed `already-delivered-recently` result
is treated as delivered → the drain marks the row done. The notice is gone, and the audit
trail says it was delivered.

For the BEACON lane this fail direction is correct and disclosed: the cost is one suppressed
heartbeat, mechanically superseded by the next cadence tick (R7-M1). But a content-hash
caller has no next tick — the suppressed send IS the message, and suppression is terminal
for a drain that treats the result as delivered. The two halves of the genuinely-unknown
outcome are NOT symmetric for one-off notices: if the message actually posted, non-suppression
costs one duplicate notice (bounded, visible, mildly annoying); if it never posted,
suppression costs SILENT loss of a user-facing message with a delivery-shaped audit record —
the exact class the spec's own R2-security-NEW-3 rule ("never record a suppressor without
positive likely-posted evidence") and the reap-notify durability guarantee ("did the user
get told? is auditable") exist to prevent. The deployed Telegram precedent the lane mirrors
records its suppressor ONLY after a successful send (`routes.ts:11264-11271` — "Recorded
only after a successful send, so a failed send's retry isn't lost"); the intent conversion
records one on unknown evidence. Latent since R6-M1 composed with the fallback lane; the
round-8 lane split narrowed the exposure from 7 days to 15 minutes but did not decide the
direction. (Not a re-litigation of the settled R6-M1 mechanism — the beacon-lane conversion
and its crash walk stand; this is the one lane-composition corner every prior round left
unswept.)

**Fix (one lane-scoped boot-conversion rule + the §10 shape):** scope the intent CONVERSION
to logical-identity callers. For a content-hash-lane pair, an intent left as the last word
at boot resolves toward RETRY — replay appends the missing `send-intent-resolved` (or
equivalently: the intent does not convert into a suppressing entry) — so the drain's retry
DELIVERS. The accepted residual, stated honestly: at most one duplicate notice per
crash-during-send whose message actually posted — the same positive-evidence posture as
R2-security-NEW-3 and the deployed Telegram precedent, and the direction "loss is never
silent" requires for one-off user-facing messages. An ambiguous outcome OBSERVED by a
surviving process still records the entry (Slack accepted = likely-posted evidence — that
path is untouched). Add the §10 shape: content-hash send → kill between the intent fsync and
transport-accept → reboot → the drain's retry within the window is NOT suppressed and
delivers exactly once from the user's perspective; the mirror beacon-lane shape (converts,
suppressed re-fire) asserted unchanged.

---

## MINOR findings (polish — batch)

1. **The `logicalSendId` encoding is stated loosely at its defining site and precisely only
   at the storage schema** `[gemini-ext #1 — classed MAJOR there; reconciled to MINOR: the
   §3.4 schema pin (`<commitmentId>:<sendSeq>`, the R5-minor-5 visible-delimiter fix) IS the
   normative encoding and every implementer of the durable store must read it; §5.0(a)'s
   "`commitmentId + sendSeq`" is prose describing the same value's composition, not a second
   contradicting pin; and the key is used for EQUALITY only (nothing parses a stored key
   back into its parts — the beacon recomputes from its own state), so even a divergent
   concatenation would be internally consistent within one implementation. The real residual
   is cross-VERSION key stability if an implementer misses §3.4 — worth closing, not
   blocking]`. Fix: make §5.0(a)'s guard-key bullet state the pinned encoding verbatim
   (`<commitmentId>:<sendSeq>`) with a pointer to the §3.4 schema example, and add one
   clause noting `commitmentId` is a house-generated id that never contains `|` (the
   composite-key delimiter) — the conversationId prefix is numeric, so the first `|` always
   delimits unambiguously.
2. **The rotation "checkpoint anchor" is a dangling requirement — written by rotation, read
   by nothing, format undefined** `[gemini-ext #2; confirmed, and sharpened by an internal
   composition observation]`. §3.4 requires "a rotation writes a fresh file whose first
   record carries the current `snapshotHighWaterSeq` as a checkpoint anchor," but no boot,
   replay, or pruning logic reads it; its record shape is not in the op enum; and under the
   new R7-minor-3 strictness the replay path's treatment of a non-enum (or non-op-shaped)
   first line is undefined — a naively-written anchor could trip the corruption HALT on
   every rotated file, or an unknown-op rule an implementer must invent. Fix: either define
   it as a real journal record (an op in the enum, idempotent no-op on replay, its one
   consumer named — e.g. journal-only disaster recovery when the snapshot is lost) or drop
   the requirement; and state the unknown-op replay rule either way.

---

## LOW findings (cosmetic — batch)

1. The §9 rollback story says the registry file is inert under rollback but does not say
   what a later RE-enable does with the stale on-disk state — the answer already exists
   (§6.2's idempotent boot-time adoption pass + journal replay compose over whatever is on
   disk); add the one-sentence cross-reference `[gemini-ext #3; confirmed]`.
2. The R7-M2 lane split is total for every caller in this spec's inventory (beacon =
   retirement; §6.1 steps 4–6 consumers = content-hash window), but a FUTURE caller passing
   a custom `logicalSendId` via `opts` without beacon-style retirement events would inherit
   retirement semantics it cannot satisfy — the R7-M2 trap shape one lane over. Add one
   sentence: a caller supplying a logical send identity MUST also define its retirement
   events, else it belongs on the window lane. `[internal]`
3. `tokenlessBindGraceDays` counts from "the proof-consumer increment has been deployed,"
   but the mechanism anchoring that clock (a PostUpdateMigrator/first-boot-at-version stamp)
   is unnamed — name it so the backstop is implementable without inventing state.
   `[internal]`

---

## Convergence recommendation

**NOT CONVERGED.**

Blocking: 1 MAJOR — the last unswept lane-composition corner of the §5.0(a) E1 machinery
(R8-M1), with a one-bullet lane-scoped fix and its §10 shape. Zero CRITICAL for the third
consecutive round; the registry core took zero findings for the second consecutive round;
and the finding surface has narrowed again: 4C+16M → 1C+3M → 1C+4M → 0C+4M → 0C+3M → 0C+1M
on a stable two-external reviewer set. All three round-7 MAJORs were independently verified
landed by BOTH externals — the first round in this ceremony where both external models
explicitly endorsed the prior round's §5.0(a) fold before finding anything new.

What is genuinely settled and should NOT be re-litigated next round: all 8 round-7
resolutions verified present and — for R7-M1, R7-M3, and R7-minor-1 — re-executed (the
un-mute walk with both crash sub-windows, the composite-key boot walk, the concurrent
first-boot walk); the delivered-equivalent suppression outcome and its crash analysis; the
lane split's window value (code-verified against the deployed Telegram constant); the
composite boot keying; everything the round-7 report's settled list carries (the 13 round-6
resolutions, the merge algebra, the windowed-cap DoS bound, the `≺` representative, the
stateless bind token, the workspace-pin corroboration design with its now-disclosed
vacuity); `## Open questions` remains verifiably empty; and this round's reconciliation of
gemini's encoding finding to MINOR-1 — re-raising any of these without a new authority delta
should be treated as settled.

Recommended next step: a Phase-2g revision addressing R8-M1 (+ the two MINORs and three
LOWs — all pin-level edits to §5.0(a)/§3.4/§9/§7/§10), then Round 9. Every remaining item
has a one-sentence-to-one-bullet fix with no architecture change; R8-M1 is the only one that
changes behavior, and only on a crash path.

**Verdict: NOT CONVERGED** (0 CRITICAL + 1 MAJOR remaining; converged requires zero MAJOR).
