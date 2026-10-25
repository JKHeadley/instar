# Side-Effects Review — the sandbox stops denying the attempt's own temp directory

**Version / slug:** `sandbox-denies-own-tmp`
**Date:** `2026-10-25`
**Author:** `Echo (instar-dev agent)`
**Second-pass reviewer:** `not required — see §4/§5 (no new decision surface; one deny-list predicate, pinned from both sides)`
**Tier:** `1` — one function, one optional parameter, two callsites in the same expression; ~12 added lines. A revert fully undoes it; no persistent state, no user-facing surface.
**Effort:** 0 spec rounds, 0 review rounds, 2 commits (the second fixes a spelling bug in the first — see Conclusion). Proportionate, and deliberately smaller than the change that found it.

## Summary of the change

`systemTempDenies(workspace)` dropped a shared system temp directory from the deny list only when
the **workspace** lived inside it. The attempt's own temp directory also lives inside it — by
design: `shortAttemptTmpDir` places it under the real `/tmp` because unix socket paths must stay
short, and the agent home is too deep to yield a short enough path.

The sandbox runtime documents that for **writes**, `denyWrite` takes precedence over `allowWrite`
(the reverse of reads, where `allowRead` wins). So `allowWrite: [..., '/private/tmp/fb-<id>']`
combined with `denyWrite: ['/tmp', '/private/tmp', …]` left the attempt unable to write its own
temp directory:

```
EPERM: operation not permitted, mkdir '/private/tmp/fb-8ac70c2cde/HH0KfR7JCSG9zBDVFZQSa'
  ❯ Proxy.fetch .../vitest/dist/chunks/resolveConfig...
```

That is the `base-unit-smoke` failure that latched the feedback executor for three days
(2026-10-22 → 2026-10-25, five consecutive 24h latches). `base-lint-gate` passed throughout
because `npm run lint` never creates a directory under `TMPDIR`; vitest does, during config
resolution. Reads were unaffected, which is exactly what the runtime's read/write asymmetry
predicts.

`systemTempDenies` now takes an optional `attemptTmpDir` and protects an ancestor of **either**
path. Both callsites — `denyRead` and `denyWrite` in `buildSandboxRuntimeSettings` — pass
`p.tmpDir`.

The comparison resolves the deepest EXISTING ancestor and re-appends the rest (`realish`). A plain
`realpathSync` is not enough and that was a real bug in the first cut of this fix: the spellings
differ per platform (`/tmp` is a symlink to `/private/tmp` on macOS; `/private/tmp` resolves to
`/tmp` on some Linux hosts), and an attempt temp directory that does not exist yet cannot be
resolved at all — so one side stayed lexical, never matched the other, and the exemption silently
did nothing.

**A pre-existing test asserted the broken policy, and that is why the bug shipped.**
`execute-short-attempt-tmpdir.test.ts` contained *"the policy still allows the temp dir and still
denies the shared temp roots around it"*, asserting `denyWrite` contained both `/tmp` and
`/private/tmp` while the attempt temp sat inside them. That pairing is exactly what the runtime
does not honour. The test is rewritten to assert the real invariant — no `denyWrite` entry may be
an ancestor of `p.tmpDir`, and the shared temp stays unwritable because it is never in `allowWrite`
— with the history recorded above it so nobody restores the old assertion.

**How this was found, which matters for trusting it:** not by reasoning. The probe's own captured
stderr named the path and the throwing module, because the change merged hours earlier
(`b84149fce`) made a failed must-succeed probe record its output instead of `exit 1`. Two prior
hypotheses — a missing npm cache redirect, then the host test-runner semaphore — were both wrong;
the captured output shows the semaphore EPERM explicitly followed by `— admitting the run
(fail-open)`, i.e. handled and harmless.

## Decision-point inventory

- `systemTempDenies` — **modify** — one predicate gains a second protected path. It computes a
  deny list; it decides nothing about agent behaviour.
- `buildSandboxRuntimeSettings` `denyRead` / `denyWrite` — **pass-through** — same call, one more
  argument. No entry is added; one is conditionally not added.

---

## 1. Over-block

No block/allow surface over agent behaviour. On the sandbox policy itself the change can only
*remove* a deny entry, never add one, so nothing that was permitted becomes refused.

---

## 2. Under-block

Stated explicitly, because this is a sandbox policy and "it only removes a deny" deserves scrutiny:

- **The shared system temp is still unwritable, and that is load-bearing.** Writes are
  allowlist-based (`allowWrite`), and the system temp itself is never in `allowWrite` — only the
  attempt's own directory under it is. Dropping the ancestor from `denyWrite` therefore does not
  make `/tmp/anything-else` writable. Verified by test (`allowWrite` contains neither `/tmp` nor
  its real path) and, every single run, by the canary's `bash-write-system-temp` must-fail probe:
  if this change had loosened the area, that probe would start *passing* and the canary would fail.
- **Reads:** `denyRead` also stops carrying the ancestor. That is a genuine widening of readable
  area in principle — but `allowRead` already re-allowed `p.tmpDir` and, for reads, `allowRead`
  wins over `denyRead`, so the attempt could already read its own temp. What changes is that other
  files directly under the system temp are no longer explicitly read-denied for the runner path.
  The canary has no must-fail probe for reading a foreign file in the system temp (its probes
  target the agent home, the config, the nonce and the keychain), so this one rests on reasoning
  rather than on a per-run proof. It is the honest residue of this change.
- **Only the runner path is affected.** `buildClaudeSandboxSettings` is untouched, and its test
  already asserts it deliberately does not deny `/tmp`.
- **A sibling path still rolls its own.** `depsCache`'s native rebuild redirects the whole of
  `HOME` for npm/node-gyp; it does not use `systemTempDenies` and is unchanged here.

---

## 3. Level-of-abstraction fit

Right layer. The collision is between two policy decisions that both live in `executePolicy` —
where the deny list is built and where the short-tmp placement is honoured — so the exemption
belongs in the predicate that builds the list, not in a caller working around it. The alternative
designs are worse: moving the attempt temp out of the system temp breaks the short-socket-path
requirement it exists for, and setting `INSTAR_HOST_TEST_SEMAPHORE=off` (the fix the second
hypothesis implied) would have addressed a condition the evidence shows is already handled.

---

## 4. Signal vs authority compliance

**Required reference:** [docs/signal-vs-authority.md](../../docs/signal-vs-authority.md)

- [x] No — this change has no block/allow surface.

It computes a filesystem deny list; it holds no authority over agent behaviour and feeds no gate.
The canary verdict logic, the latch and the retry ladder are all untouched. The change makes a
must-succeed probe able to succeed; it does not alter what the canary asserts or how it judges.

---

## 4b. Judgment-point check (Judgment Within Floors standard)

No new static heuristic at a competing-signals decision point. The predicate is an ancestry test
over two concrete paths — an invariant (a process must be able to write its own temp directory),
not a weighing of live signals.

---

## 5. Interactions

- **Shadowing:** none. `systemTempDenies` has one definition and two callsites, both inside the
  same settings object.
- **Double-fire:** none — a pure function returning a list.
- **Races:** none. The real-path resolution is a `realpathSync` with a lexical fallback on failure,
  so an unresolvable path still produces a deny entry rather than silently vanishing from the list.
- **Feedback loops:** the canary's own must-fail probe is downstream of this list, which is the
  useful direction: a loosening regression surfaces as a canary failure, not as silence.
- **Prior fix in the same area:** `confinedCacheEnv` (merged in `b84149fce`) added
  `npm_config_cache` on the npm-cache hypothesis. The evidence shows that was not the cause. It is
  left in place: it is harmless, matches the `VITEST_CACHE_DIR`/`ESBUILD_CACHE_DIR` precedent
  beside it, and removing it would be a second unevidenced change in the opposite direction.

---

## 6. External surfaces

- **Other agents / install base:** the feedback executor is dev-gated (`feedbackFactory.execute`,
  503 on the fleet) and runs on one operated host.
- **External systems:** none.
- **Persistent state:** none. No new field, no migration.
- **Operator surface:** none added or changed.
- **Timing/runtime:** two extra `realpathSync` calls per settings build (one per protected path),
  on a path already doing filesystem work.

---

## 6b. Operator-surface quality

No operator surface — not applicable.

---

## 7. Multi-machine posture (Cross-Machine Coherence)

**machine-local BY DESIGN.** The deny list describes *this machine's* filesystem — its real temp
paths, its home, its agent home — and the executor runs only on the operated host
(`feedbackFactory.operatedHostMachineId`). A list computed on one machine is meaningless on
another. No notices, no durable state, no generated URLs, so nothing to gate, strand or carry.

---

## 8. Rollback cost

- **Hot-fix release:** revert the commit, ship as the next patch.
- **Data migration:** none.
- **Agent state repair:** none.
- **User visibility:** reverting restores the three-day `base-unit-smoke` failure — which is now
  diagnosable in one read rather than three days, since the probe records its own output.

---

## Conclusion

This review's useful output was the Under-block section rather than a design change. "It only
removes a deny entry" is the kind of claim that sounds self-evidently safe, and it is safe for
writes for a specific, documented reason (allowlist semantics plus a per-run must-fail probe) —
but it is *not* equally proven for reads, because `denyRead` also stops carrying the ancestor and
no probe covers reading a foreign file in the system temp. That residue is named rather than
smoothed over.

The fix itself is small and pinned from three sides, all verified by deliberately breaking the
code: reverting the `attemptTmpDir` arm fails, over-exempting fails, and a leaf-only
`realpathSync` — the spelling bug the first cut actually had — fails. That third mutation matters
most: the first cut typechecked, passed my own new tests, and did nothing, and it was the
PRE-EXISTING test (the one that had asserted the wrong policy) that caught it once rewritten.

Worth recording about provenance: this was found by reading the probe's own captured stderr, not
by reasoning. Two hypotheses I held with some confidence — the npm cache and the host test-runner
semaphore — were both wrong, and the second one's obvious fix would not even have worked (the
semaphore reads its files before the kill switch is consulted). Three days of `exit 1` ended the
first time the probe was allowed to speak.

Clear to ship.

---

## Second-pass review (if required)

**Not required.** The trigger list targets block/allow decisions, session lifecycle, and gates
holding authority. This change adds no decision surface: it removes one entry from a filesystem
deny list under an ancestry test, leaves every canary verdict, latch and ladder untouched, and is
pinned from both directions by mutation-verified tests. The change that *found* it took three
adversarial rounds precisely because it touched a gate's inputs; this one does not.

---

## Evidence pointers

- The captured probe output that identified it (from `GET /feedback-factory/execute/status`,
  `profileUnenforceable.failedDetail`, 2026-10-25 00:49 PDT):
  `exit 1 — stderr: … EPERM: operation not permitted, mkdir '/private/tmp/fb-8ac70c2cde/HH0KfR7JCSG9zBDVFZQSa' ❯ Proxy.fetch …/vitest/dist/chunks/resolveConfig…`
  and, immediately before it, the semaphore EPERM followed by `— admitting the run (fail-open)`.
- The runtime's documented precedence (`node_modules/@anthropic-ai/sandbox-runtime/README.md`):
  "`denyWrite` takes precedence over `allowWrite`" and, for reads, "`allowRead` takes precedence
  over `denyRead`".
- Mutation-verified three ways: reverting the `attemptTmpDir` arm fails; exempting every system
  temp whenever a tmpDir is passed fails; and a leaf-only `realpathSync` instead of `realish`
  fails (the defect the first cut shipped with).
- `tests/unit/feedback-factory/` 46 files / 643 tests green; `npm run lint` clean; `tsc` clean.
- Observed on this host, which is why `realish` exists: `realpathSync('/private/tmp')` → `/tmp`,
  while `realpathSync('/private/tmp/fb-<id>')` throws because the directory does not exist yet.

---

## Class-Closure Declaration (display-only mirror)

No agent-authored-artifact defect — not applicable. The defect is in instar's own TypeScript (a
deny-list predicate that protected one required path and not the other), not in an LLM prompt,
hook, config, skill, or standards text. No self-triggered controller is added or modified.
