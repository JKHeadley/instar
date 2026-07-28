# Side-Effects Review — a raw NUL byte made 30 source files invisible to grep

**Version / slug:** `raw-nul-bytes-hide-source-from-grep`
**Date:** `2026-07-26`
**Author:** `Echo (instar-dev agent)`
**Second-pass reviewer:** `author-applied lenses — see Phase 5 (reduced independence, disclosed)`

## Summary of the change

`grep` classifies a file as binary if it contains a NUL (0x00) byte, and on a binary
file it emits **nothing** — not a match, not a `Binary file X matches` line, not even a
`0` under `-c`. Thirty tracked text files each contained one or more raw NUL bytes, so
every grep-based audit over `src/` silently skipped them and the empty result read as
"absent".

The bytes were never corruption. Each was a deliberate composite-key or hash separator
written as a literal byte instead of the six-character escape:

```ts
const key = `${row.model}<literal 0x00>${row.framework}`;   // now: \u0000
```

The delimiter choice is correct — NUL cannot occur inside a model or framework name, so
it is collision-proof. Writing it raw is the whole defect.

**Measured:** 30 tracked files (22 under `src/`, 7 tests, 1 spec doc). Affected modules
include `blockerSettleAuthority.ts` (the true-blocker settle gate), `SessionOwnership.ts`,
`GreenPrAutoMerger.ts`, `PermissionPromptAutoResolver.ts` (an always-on safety floor),
all three `ExternalHog*` modules, and `StandardsEnforcementAuditor.ts` — the module that
audits whether standards carry structural guards was itself invisible to the standard
search instrument.

**Second consequence, worse in kind:** git applies the same rule but only sniffs the
first 8000 bytes. For the **11 files** whose NUL fell inside that window, `git diff`
rendered `Bin 5407 -> 5412 bytes` instead of a line diff — so pull requests touching
safety-critical authority code were reviewed **without the reviewer being shown the
changed lines**. For the other 19, git saw text while grep did not: the two instruments
disagreed, which is precisely why this survived so long.

Every raw byte is replaced with `\u0000` (identical runtime string; valid and unambiguous
in string, template and regex contexts — unlike `\0`, a legacy octal escape when followed
by a digit), and a new ratchet fails the build if one ever returns.

## Decision-point inventory

| point | classification | note |
|---|---|---|
| `containsRawNul(file)` | `invariant` | A byte is present or it is not. No judgment, no model, no competing signals. |
| lint scope (extension allowlist) | `invariant` | Deterministic set of text-by-definition extensions. Binary fixtures are out of scope by construction, not by heuristic. |
| control bytes other than 0x00 | `invariant` (deliberate exclusion) | Empirically verified not to cause grep-skip; see §2. |

## 1. Over-block

**What legitimate inputs does this change reject that it shouldn't?**

The lint rejects a raw 0x00 byte in a file with a text extension. There is **no
legitimate case it blocks**, because there is no case that needs one: any runtime NUL a
program wants is expressible as an escape, with an identical result. The lint therefore
carries no exemption list — an exemption would only ever be used to reinstate the defect.

The nearest real cost: a genuinely binary fixture that someone gives a `.json`/`.md`
extension would be refused. That is a naming error the lint is right to surface, and no
such file exists in the tree today (verified by the sweep).

## 2. Under-block

**What failure modes does this still miss?**

- **Other raw control bytes remain.** ESC (0x1b), BEL (0x07), 0x1f and 0x7f appear in a
  handful of hostile-input test fixtures (`RevertDetector.ts`, `liveOutputStream.ts`,
  `process-health-render.test.ts`, and others). These are **deliberately not covered**:
  I verified empirically that a file containing ESC/BEL is still `ASCII text` to `file`
  and still fully searchable by `grep` — only 0x00 triggers the skip. Escaping them would
  be cosmetic. A lint should enforce exactly the failure it is named for. Recorded rather
  than silently widened. (A separate concern does exist — a raw ESC in a file that gets
  `cat`'d is a terminal-escape vector — but that is a different defect with a different
  argument, and folding it in here would smuggle it past review.)
- **Untracked and generated files are not scanned.** The lint walks `src`, `tests`,
  `docs`, `scripts`, `.github`. Build output is excluded on purpose (it is regenerated
  from the now-clean sources).
- **This fixes one silent instrument, not the class.** Other tools can also fail
  closed-mouthed. Nothing here establishes that no others remain — see §5.

## 3. Level-of-abstraction fit

**Is this at the right layer?**

Yes, and at two layers deliberately:

1. **The data** — the bytes themselves are corrected at source, which is the only place
   the fix can be complete. A tooling workaround (`grep -a` everywhere, a `.gitattributes`
   override) would have left the files hostile to every *other* consumer, including
   editors, reviewers, and any future agent's search.
2. **The guard** — a repo-level test, matching the existing tree-scanning ratchets
   (`no-empty-catch-blocks`, `no-silent-fallbacks`). It reads bytes with `readFileSync`
   rather than shelling out to a search tool, so the lint cannot be blinded by the very
   defect it detects.

Notably a `.gitattributes` `*.ts text` entry was considered and **rejected**: it would
have fixed git's rendering while leaving `grep` — the instrument that actually failed —
just as blind, and would have converted a visible defect into a hidden one.

## 4. Signal vs authority compliance

**Required reference:** [docs/signal-vs-authority.md](../../docs/signal-vs-authority.md)

**Does this change hold blocking authority with brittle logic?**

It holds blocking authority (a failing test blocks a merge) on **maximally non-brittle**
logic: the presence of one specific byte in a file. There is no model, no heuristic, no
threshold, no parse. It cannot drift, cannot be rate-limited, and produces the same
verdict on every machine.

This is the correct place for hard authority — a deterministic, universally-checkable
fact — and precisely the shape the standard reserves it for.

## 4b. Judgment-point check (Judgment Within Floors standard)

No judgment point is introduced. Every decision in the lint is a byte comparison or a
set membership test. Nothing consults an LLM; nothing weighs competing signals.

## 5. Interactions

- **Runtime behaviour is unchanged.** `\u0000` denotes exactly the byte it replaces. The
  lint asserts this explicitly (`JSON.parse` of the escape text `=== String.fromCharCode(0)`)
  rather than leaving it as a claim in prose.
- **Persisted data is unaffected.** Several sites feed these separators into hashes
  (`relayContentDedup`, `blockerSettleAuthority`, `UnionReader`, `ExternalHogArmMarker`).
  Because the string is identical, every hash is identical — **no migration, no cache
  invalidation, no re-keying**. This was the primary risk and it is checked, not assumed.
- **`git diff` becomes readable** for the 11 previously-binary files. A one-time
  consequence: this PR shows them as `Bin` on the *old* side.
- **The empty-catch ratchet** scans `src/` as text via `readFileSync`, so it was NOT
  blinded — verified before assuming a shared failure. Grep-based *ad hoc* audits were the
  affected consumers, not the file-reading lints.
- **This session's own reasoning was affected.** A search for a retraction mechanism
  across `src/` returned one unrelated subsystem, and I was one step from recording
  "no such path exists" as a finding. That search had skipped 22 source files. The
  correction is recorded in the run log rather than quietly dropped: **the finding I was
  about to publish was manufactured by the defect this PR fixes.**

## 6. External surfaces

None. No route, no config key, no persisted state, no user-visible behaviour. This is a
source-text and build-time change only.

## 6b. Operator-surface quality

Nothing reaches the operator. The one surface is the failing-test message, which names
each offending file, states the consequence in plain terms ("INVISIBLE to grep — every
grep-based audit silently skips them and reports 'not found'"), and gives the exact fix.
A lint that only says "assertion failed" would have re-created the original problem at
the level of the guard.

## 7. Multi-machine posture (Cross-Machine Coherence)

**Posture: `unified` by construction — no state at all.** This change introduces no
feature, no field, no file, no surface. It edits source text and adds a build-time check
that runs identically wherever the repo is checked out. No replication path is required
and no `machine-local-justification` marker applies, because there is nothing machine-local
to justify.

## 8. Rollback cost

Trivial and total: one commit, 30 files, 33 single-line substitutions plus one new test
file. Reverting restores the raw bytes — and with them the grep-invisibility of 22 source
modules and the binary diffs on 11. There is no data to migrate back and no state to
unwind.

## Phase 5 — Second-pass review (independent reviewer subagent)

**Disclosure, per Truthful Provenance:** no independent reviewer subagent was spawned — a
standing instruction in this session prohibits it unless the operator requests it. The
review lenses were applied by the author. That is **reduced independence**, recorded as
such rather than presented as a concurring second pass.

What author-applied review caught and changed:

1. **The first draft of this very lint shipped five raw NUL bytes and hid itself from
   grep.** I typed the escape inline; it was normalised into actual NUL bytes on write.
   Caught only because I byte-checked the file I had just written instead of trusting it.
   The lint now constructs both the raw byte and the escape *text* from char codes and
   never types the escape inline — and the authoring hazard is documented in its header,
   because the next author will hit exactly the same trap.
2. **The scope was nearly widened to all control bytes** for tidiness. I tested the
   assumption instead and found ESC/BEL do not cause the skip — so widening would have
   added churn and noise while claiming safety it does not provide. Narrowed back, with
   the empirical result recorded in §2.
3. **A "scan is not silently empty" assertion was added.** Without it, a scan that walked
   the wrong roots would find zero offenders and pass forever — the same absence-reads-as-
   presence failure, reincarnated inside its own guard. The lint now asserts it examined
   >500 files.
4. **The hash-stability question was checked, not assumed.** Four sites feed these
   separators into digests; had the substitution altered the string, persisted dedup keys
   and arm markers would have silently changed meaning. Verified identical before
   committing.
5. **`.gitattributes` was rejected as the fix** (see §3) because it would have repaired
   the *visible* symptom (git diffs) while leaving the *silent* one (grep) intact —
   trading a detectable failure for an undetectable one.
