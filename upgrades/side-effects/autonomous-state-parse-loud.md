# Side-Effects Review — Visible autonomous-state parse failure

**Version / slug:** `autonomous-state-parse-loud`
**Date:** `2026-07-28`
**Author:** `instar-codey`
**Second-pass reviewer:** `Euler (independent Codex second pass)`

## Summary of the change

The bundled autonomous stop hook now distinguishes an absent state file from a
selected state file whose fenced frontmatter cannot supply the required
`active: true|false` control field. Absence remains a silent exit 0; corrupt
selected state emits a specific error to stderr and exits nonzero. The
PostUpdateMigrator capability marker is bumped with an exact-anchor in-place
patch for anchor-compatible recent revisions and exact historical stock hashes
for older canonical revisions. Behavioral tests execute the real hook while
also checking the server-side reader on the same fence-less input.

## Decision-point inventory

- `.claude/skills/autonomous/hooks/autonomous-stop-hook.sh` state admission —
  **modified** — after a file is selected, invalid control frontmatter changes
  from permissive clean exit to visible structural failure.
- Codex dark-launch gate — **pass-through** — it still runs before state parsing;
  a disabled hook remains a no-op.
- Existing `active: true|false` decision — **pass-through** — valid true and
  false values retain their prior behavior.
- `PostUpdateMigrator` hook deployment — **modified** — a new capability marker
  patches three exact unique prior-version anchors in place. Older canonical
  revisions are replaceable only by exact SHA-256 identity. Unrelated custom
  bytes survive; unknown or ambiguous layouts are left untouched.

---

## 1. Over-block

The new structural refusal rejects a selected fenced file that omits `active`,
uses a value other than the writer contract’s literal `true` or `false`, or has
fewer than two exact `---` delimiter lines. A hand-authored file using YAML
synonyms such as `yes` would now fail visibly even though a general YAML parser
might accept it. That is intentional: neither existing reader treats `yes` as
active, and allowing it would recreate an ambiguous clean-exit state.

Valid `active: false` files and the genuinely absent-file case are separately
test-pinned as clean exit 0, so the refusal does not absorb the normal no-job
surface.

---

## 2. Under-block

The hook still uses its established line-oriented parser rather than a full YAML
parser. A file with two delimiter lines and a literal `active: true|false` can
pass this structural gate even if optional fields are malformed. Existing
downstream validation and conservative defaults continue to own those fields.

This change also does not make the server and shell share a parser. It closes
the dangerous equivalence between “file absent” and “selected file cannot
supply its required control field”; broader parser unification is not required
to make this failure observable.

---

## 3. Level-of-abstraction fit

The check sits immediately after the hook has selected an existing state file
and before the `active` allow/block decision. That is the narrowest layer with
all required facts: selection already proved the file exists, and the hook owns
the fenced-frontmatter contract it is about to consume. Moving the check to the
server reader would leave the hook’s silent exit intact; moving it into every
writer would not cover partial edits or corruption.

This is a deterministic structural validator over an enumerable contract, not
a semantic detector or a competing-signals judgment.

---

## 4. Signal vs authority compliance

**Required reference:** [docs/signal-vs-authority.md](../../docs/signal-vs-authority.md)

**Does this change hold blocking authority with brittle logic?**

- [ ] No — this change produces a signal consumed by an existing smart gate.
- [ ] No — this change has no block/allow surface.
- [ ] Yes — but the logic is a smart gate with full conversational context
  (LLM-backed with recent history or equivalent).
- [ ] ⚠️ Yes, with brittle logic — STOP. Reshape the design.

None of the generic boxes exactly names this allowed exception. The change does
hold failure authority, but only for the hard-invariant case explicitly exempted
by `docs/signal-vs-authority.md`: after an existing file is selected, its
control block must be fenced and `active` must be one of two enumerable literal
values. No message meaning, intent, confidence score, or conversational context
is evaluated. The same bytes always produce the same result and the error states
which structural contract failed.

---

## 4b. Judgment-point check (Judgment Within Floors standard)

No static heuristic is added at a competing-signals decision point. File
existence, delimiter count, and the two allowed `active` literals are an
enumerable state-format invariant. Liveness, ownership, urgency, work evidence,
and completion judgment remain with their existing downstream authorities.

---

## 5. Interactions

- **Shadowing:** the parse check runs after topic/legacy state selection and the
  Codex feature gate, but before all state-derived lifecycle checks. It shadows
  those checks only when their required control document is corrupt; running
  them with fabricated empty values was the defect.
- **Double-fire:** one hook invocation emits at most one parse error and exits.
  It does not call Telegram, Attention, recovery audit, or run-end notification
  paths.
- **Races:** if the state file disappears between selection and read, the same
  visible failure occurs. That is conservative and observable; the ordinary
  no-state path still applies when removal wins before selection.
- **Feedback loops:** no state is written and no retry is scheduled. The change
  cannot repair or re-trigger itself.
- **Migration:** the capability marker upgrade patches only three exact unique
  anchors on compatible recent revisions and preserves every unrelated byte.
  Older canonical stock revisions are recognized by a repository-history
  SHA-256 allowlist and receive the bundled hook through a same-directory atomic
  rename. A stock-derived customized hook is test-pinned to retain its custom
  line; a stock-looking hook whose layout lacks both proofs is test-pinned to
  remain byte-identical and report a skipped migration. Exact historical tests
  cover the original session-keyed and topic-keyed v1.2.55-era hooks and run
  `bash -n` on the deployed result.

---

## 6. External surfaces

Other agents receive a visible hook failure instead of silence if their selected
autonomous state is malformed. Valid runs and ordinary non-autonomous sessions
have no output change. The error goes to stderr so Codex stdout remains empty or
valid decision JSON, preserving its stop-hook protocol.

No external API, Telegram/Slack message, dashboard surface, URL, database, or
durable state shape changes. The hook does not mutate the malformed file.

No operator-facing action is added; repair remains through existing state
writers or operator controls.

---

## 6b. Operator-surface quality (Operator-Surface Quality standard)

No operator surface — not applicable.

---

## 7. Multi-machine posture (Cross-Machine Coherence)

**Machine-local by design.** Each autonomous worker consumes the state file for
the topic/session it owns on that machine. The structural parse result must
therefore reflect the local file bytes; there is no meaningful merged verdict
to replicate. The behavior itself ships to every stock installation through the
normal update migrator.

The change emits no user-facing notices, holds no new runtime state, and
generates no URLs. Topic transfer remains governed by the existing autonomous
state movement/ownership paths; this check neither copies nor deletes state.
The class-closure process has one durable local action because the nearest
defect class is still operator-unconfirmed; that action changes no run state.

---

## 8. Rollback cost

Rollback is code-only and requires no data migration or state repair. Revert the
validator and ship a patch. Because existing installs may already carry the new
capability marker, an intentional rollback release must use a newer marker to
re-deploy or patch the reverted behavior; simply restoring the old marker would
not move already-updated installs backward. Unknown layouts remain unaffected
in either direction.

---

## Conclusion

The change is bounded to the structural ambiguity that caused the live failure:
absent and unparseable are no longer byte-identical outcomes. The review added
an explicit migration marker bump and kept Codex protocol output on stderr.
Valid success/allow paths, state ownership, notification behavior, and state
mutation are unchanged. The implementation is ready for independent second-pass
re-review after resolving the reviewer’s two initial blockers.

---

## Second-pass review (if required)

**Reviewer:** `Euler`
**Independent read of the artifact:** Initial review found two blocking issues:
the generic header fingerprint could overwrite a customized stock-derived hook,
and the proposed defect class was unconfirmed. The first re-review confirmed
both corrections, then found one migration-parity regression: old canonical
stock layouts were being skipped. Final re-review approved the exact historical
SHA-256 fallback and restored session-keyed/v1.2.55 proofs. The reviewer also
exhaustively migrated all 21 canonical revisions, ran `bash -n` on every result,
and verified customized derivatives were preserved or refused safely.

---

## Evidence pointers

- `tests/unit/autonomous-stop-hook-state-parse.test.ts`
- `tests/unit/PostUpdateMigrator-autonomousStopHook.test.ts`
- `tests/unit/autonomous-stop-hook-notify.test.ts`
- `.claude/skills/autonomous/hooks/autonomous-stop-hook.sh`
- `src/core/PostUpdateMigrator.ts`

---

## Class-Closure Declaration (display-only mirror)

- **`defectClass`** — `unknown-classification-fail-open`
- **`closure`** — `gap`
- **`guardEvidence`** — not applicable while the class remains unconfirmed
- **`gap`** — `ACT-108` — operator confirmation is required before
  `unknown-classification-fail-open` can supply class-level closure. The
  instance-level regression test already prevents this exact hook defect from
  returning.
