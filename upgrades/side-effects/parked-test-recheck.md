# Side-effects review — parked-test re-check (the exit path for FLAKY_TESTS)

**Change:** adds `scripts/recheck-parked-tests.mjs`, which reports which `FLAKY_TESTS` entries now
pass deterministically and which point at files that no longer exist. Read-only; never edits config.

**Decision point touched?** No gate is added or changed. It informs a human judgement (should this
test be re-armed?) that currently has no prompt at all.

---

## 1. Over-block

None possible: the script always exits 0 and modifies nothing. Making it a gate was considered and
rejected — a red build for a test somebody parked deliberately would recreate the original problem
from the other side.

## 2. Under-block

Deliberate and central: it does NOT re-arm. A local deterministic-pass does not establish a CI pass,
and roughly a third of the list is parked for a native-binding failure whose stated scope is literally
"on this machine" while CI is a different environment. Auto-re-arming on local green would be the
confident-wrong-answer this area keeps producing.

It also cannot evaluate glob entries (`tests/unit/threadline/**`) — those are reported separately
rather than resolved, because a glob is not a file and pretending otherwise would put fake entries in
the missing list.

Bounded by default: only a rotating slice is executed per run. So a single run does NOT survey the
whole list, and the output says how many were checked. Under-coverage that announces itself.

## 3. Level-of-abstraction fit

Correct. The gap is that the exclusion list has an entry path and no exit path; this is the exit
path's reporting half. The complementary half — requiring evidence on ADDITIONS — is tracked
separately (ACT-1341) and is a gate change, not a report.

## 4. Signal vs authority compliance

Pure signal, and deliberately so. Per `docs/signal-vs-authority.md` it produces information for an
authority (a human) that already exists; it holds none itself.

## 5. Interactions

Reads `vitest.push.config.ts` by literal parse rather than importing it — importing would execute the
config, and this must remain safe to run against a config that does not load. It executes vitest as a
subprocess for the sampled files; those runs go through the normal host test-runner bound like any
other.

No production code touched. Nothing imports the script.

## 6. External surfaces

None. A developer-facing script; no endpoint, no config key, no agent-visible behaviour.

## 7. Multi-machine posture

Not applicable in the replication sense, and that is itself the point: the answer it produces is
about THIS machine's environment, and the script says so in its own output note. A cross-machine
merged view would be actively misleading, since the whole question is whether a local environment
reason still holds.

## 8. Rollback cost

Trivial — delete the script and its test. No state, no schema, no consumers.

## A correction this change surfaced

The first implementation's naive parser produced a count of 92 parked entries. The true count is 91.
That wrong number was published in the release note of the earlier re-arm change (`#1668`). It is
recorded here rather than silently corrected, because a plausible-but-wrong number that reached an
artifact is exactly the failure class this repository keeps finding.
