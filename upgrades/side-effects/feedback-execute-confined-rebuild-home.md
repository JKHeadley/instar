# Side-Effects Review — Confined native rebuild gets a writable HOME; its failure is carried

## Summary of the change

`depsCache.buildNatives()` runs `npm rebuild` inside the sandbox runtime. The confinement policy
puts `os.homedir()` in `denyRead`, but npm and node-gyp keep caches under `$HOME`, so node-gyp's
`configure` step died with `EPERM ... open '~/Library/Caches/node-gyp/<ver>/installVersion'` and no
rebuild could ever succeed. `HOME` is now pointed at a per-attempt directory inside the attempt's
own temp. Separately, the throw discarded the runner's captured `stdout`/`stderr`; it now carries a
bounded, secret-scrubbed diagnostic line, and `ensure()` stops cutting the reason to 200 chars.

## Decision-point inventory

- `depsCache.buildNatives()` env construction — **modify** — adds `HOME` (per-attempt temp) to the
  existing `confinedEnv(process.env, { TMPDIR })` overrides.
- `depsCache.buildNatives()` failure throw — **modify** — the message gains a bounded, scrubbed tail.
- `depsCache.ensure()` failure reason — **modify** — truncation 200 → 400 chars.
- `rebuildFailureTail()` — **add** — a pure line-selection function. No block/allow surface.

## 1. Over-block

Nothing new can be blocked. This change removes a failure mode and adds no refusal, gate, or
threshold. The only behavioural delta on the success path is which directory the toolchain writes
its own caches into. The sandbox's own allow/deny lists are not touched, so no call that previously
succeeded can now be refused.

## 2. Under-block

The load-bearing question: does pointing `HOME` into the sandbox weaken confinement? No.
`buildSandboxRuntimeSettings` is unchanged — `os.homedir()` remains in `denyRead`, and the real
home is as unreachable after this change as before. `HOME` is an environment variable telling a
process where to look; it is not an entry in the policy. The rebuild now writes its caches to a
directory the policy already permits (the attempt temp, already in `allowWrite`), instead of
attempting a directory the policy forbids. Verified rather than assumed: the failure reproduces
against the real home before the change and disappears after it, with the same settings object.

## 3. Level-of-abstraction fit

Two fixes were available: loosen the policy to admit the home cache paths, or stop asking the
toolchain to use the home. The second is strictly narrower — it is scoped to one command's
environment and leaves the security boundary identical for every other confined command. Widening
`allowWrite` to cover `~/Library/Caches` and `~/.npm` would have granted every confined command
write access to two home directories to fix one command's cache location.

## 4. Signal vs authority compliance

- [x] No — this change has no block/allow surface.

`rebuildFailureTail()` is deterministic text selection over output that has already been produced;
it decides nothing. The existing authority (a non-zero exit code → `deps-unavailable`) is unchanged;
only the explanation attached to it improves.

## 4b. Judgment-point check (Judgment Within Floors standard)

No judgment point is added. There is no model call, no heuristic verdict, and no threshold. The
line-selection regex chooses which already-emitted line to quote and cannot change the outcome.

## 5. Interactions

- **Shadowing:** none. No check runs before or after this; the rebuild's exit code is still the
  single determinant of success.
- **Double-fire:** none. `buildNatives` is called once per `ensure()`, under the existing cache
  readiness check.
- **Races:** the new directory is `<attempt temp>/home`, created per attempt beneath a path that is
  already per-attempt, so two concurrent attempts cannot share or clobber it. It is removed with the
  attempt tree by the existing `removeAttemptTree` discard path.
- **Feedback loops:** the reason text feeds the `deps-unavailable` degradation, which is read by
  operators and by the executor's own status surface. It is reporting only — nothing consumes the
  reason to decide a retry.

## 6. External surfaces

- **Other agents on the same machine:** none — the deps cache is per-agent and machine-local.
- **Install base:** behaviour-identical where the rebuild already worked (a path copy or a
  successful rebuild); strictly better where it did not.
- **External systems:** none. The network allow-list is unchanged, and no new host is contacted.
- **Persistent state:** one extra directory inside the attempt's temp tree, discarded with it.
  No schema, no ledger, no migration.
- **Timing:** the rebuild now populates a cold cache per attempt instead of reusing a warm home
  cache, so a rebuild may do slightly more work. It is bounded by the existing
  `CONFINED_COMMAND_TIMEOUT_MS`, and the measured run completed well inside it.
- **Operator surface (Mobile-Complete Operator Actions):** no operator-facing action is added or
  touched, so there is nothing requiring a phone-completable surface. The only operator-visible
  change is that an existing failure string becomes informative.

## 6b. Operator-surface quality (Operator-Surface Quality standard)

No operator surface is added. The one operator-visible string is a failure reason, which now names
the real cause in place of a bare exit code. It carries no JSON blob, hash, or enum as headline
content; it is a single quoted line from the tool that failed, scrubbed and length-bounded.

## 7. Multi-machine posture (Cross-Machine Coherence)

No multi-machine surface. The dependency cache, the attempt tree and the sandbox invocation are all
machine-local; nothing here replicates, takes the lease, or is read by a peer. The executor already
runs only where it is configured to run, and this change does not alter that placement. A peer on a
different machine is unaffected whether or not it carries this commit.

## 8. Rollback cost

A revert of one commit. No configuration to unset, no persisted state to migrate, no flag to flip,
and no operator action. Because the change is the difference between "the rebuild always fails" and
"the rebuild succeeds", a regression would present as the pre-existing `deps-unavailable` — now with
its reason attached, which is strictly more diagnosable than the state being replaced.

## Conclusion

Proceed. The change is narrow, removes no safeguard, adds no authority, and is confined to one
command's environment plus the text of one error. It was verified by reproducing the failure through
the real `SandboxRuntimeRunner` in production's layout and observing it clear.

## Second-pass review (if required)

Not required — Tier 1 (37 LOC across one source file; the tier signal independently computed
`suggestedTier=1`, `riskFloor=1`). No new decision point, no block surface, no persisted state.

## Evidence pointers

- Failing run, real runner, cache under the agent home (production layout):
  `EXIT=1`, `gyp ERR! configure error`, `EPERM ... node-gyp/24.14.1/installVersion`.
- Passing run, same settings plus the `HOME` redirect: `EXIT=0`,
  `rebuilt dependencies successfully`, `better_sqlite3.node` present at 1,897,088 bytes, and the
  secondary `prebuild-install warn install EPERM` absent.
- A discarded intermediate run placed the cache under `/tmp` and produced a *different* EPERM
  (`unlink build/Release/...`); that was a harness artifact of macOS resolving `/tmp` to
  `/private/tmp` so the literal `allowWrite` prefix did not match, and is why the result above was
  re-run under the agent home.
- Tests: `tests/unit/feedback-factory/execute-units.test.ts` 37/37, `execute-wiring.test.ts` 6/6,
  `npm run lint` exit 0, `tsc --noEmit` clean.

## Class-Closure Declaration (display-only mirror)

The class is "a confined command that needs a writable per-process home". `better-sqlite3` is the
only member reachable today: `NATIVE_REBUILD_ALLOWLIST` is `['better-sqlite3', 'sqlite-vec']`, and
`sqlite-vec` is explicitly skipped by `buildNatives` (it ships prebuilt platform packages through
the lockfile, and the function `continue`s when `binRel` is null). The fix is applied at the single
`runner.run` call that builds natives, so it covers the whole class rather than one module — any
future entry added to that allow-list inherits it without further change.
