# REPORT CI6 — MR1 missed test population

## Result

The model-registry repair is complete on draft branch
`phaseb/mr1-model-registry-review`, starting from head
`8350ada31c28f0f59f80b9472acf4b96051b39d3`. I did not rebase the branch and did not change its
draft state.

The coordinator's twelve annotation locations resolved to eleven reproducible model-routing test
failures across five files plus one separate tmux failure. The eleven model-routing cases are fixed
by updating exact expected values and controlled confirmation inputs to the reviewed source values:

- Codex capable: `gpt-5.5` to `gpt-5.6-sol`.
- Claude default tier: `claude-opus-4-8` to `claude-opus-5`.

No production file, model pin, manifest, allowlist, matcher, skip, or test population changed. The
tmux file is untouched.

## The twelve supplied locations, individually accounted for

| supplied location | disposition |
| --- | --- |
| `tests/integration/cross-model-review-flow.test.ts:155` | Repaired the exact model expectation and the same test's dependent flag, banner, and frontmatter expectations to `gpt-5.6-sol`. |
| `tests/integration/cross-model-review-flow.test.ts:216` | Repaired the degraded flag and its stamped frontmatter expectation to `gpt-5.6-sol`. |
| `tests/integration/model-tier-swap-route.test.ts:227` | Repaired the controlled confirmation tail, injected command expectation, and saved-session expectation to `claude-opus-5`; the existing exact status assertions remain unchanged. |
| `tests/integration/model-tier-swap-route.test.ts:244` | Repaired the controlled confirmation tail and saved-session expectation to `claude-opus-5`; the existing exact status assertions remain unchanged. |
| `tests/integration/tmux-literal-send-ceiling.test.ts:108` | Not changed. This is a separate tty-readiness race, described below, and both required local runtime runs passed all three tmux controls. |
| `tests/unit/crossModelReviewer.test.ts:90` | Repaired the exact detected capable-model expectation to `gpt-5.6-sol`. |
| `tests/unit/crossModelReviewer.test.ts:318` | Repaired the exact result model plus the same test's reviewer attribution and flag expectations to `gpt-5.6-sol`. |
| `tests/unit/crossModelReviewer.test.ts:334` | Repaired the exact degraded flag expectation to `gpt-5.6-sol`. |
| `tests/unit/modelSwapService-topicProfile.test.ts:156` | Repaired the confirmation oracle and exact resolved-model expectation to `claude-opus-5`. |
| `tests/unit/modelSwapService-topicProfile.test.ts:169` | Repaired the fallback confirmation oracle and exact resolver-default expectation to `claude-opus-5`; the off-enum refusal assertion is unchanged. |
| `tests/unit/modelSwapService.test.ts:326` | Repaired the post-dwell confirmation oracle to the reviewed `claude-opus-5` default; the exact swapped-status assertion is unchanged. |
| `tests/unit/modelSwapService.test.ts:333` | Repaired the confirmation oracle and exact returned-model expectation to `claude-opus-5`; budget and lease assertions are unchanged. |

The annotation list named the first failed assertion in each test. Several tests had later exact
expectations that never executed after that first failure. The finished diff therefore changes 25
lines: 23 exact expectations or their controlled inputs and two comments that describe those same
expectations. It does not broaden the test population.

## What MR1-B missed

The miss followed a clear boundary. MR1-B updated direct registry and resolver tests, but it did not
enumerate transitive consumers of those resolvers. The missed cases fall into two downstream forms:

1. Codex review results copy the resolved model into flags, reviewer attribution, banners, and
   frontmatter.
2. Claude de-escalation tests simulate the CLI confirmation text. Once the configured default moved,
   their old confirmation oracle no longer matched the command actually sent, so the result was
   correctly `unconfirmed` or HTTP 202 before the stale later expectation could run.

This is why a global old-ID replacement would have been wrong. Other occurrences deliberately test
historical sessions, explicit topic pins, arbitrary pass-through IDs, parser inputs, or retained
non-frontier registry history, and they remain unchanged.

## Separate verdict on the tmux anomaly

The tmux annotation is unrelated to model routing. The failed Node 22 shard observed:

```text
Expected: 39978
Received: 4095
tests/integration/tmux-literal-send-ceiling.test.ts:108
```

That exact 4095-byte result is the Linux canonical tty line-buffer ceiling. The test starts a tmux
session whose shell is asked to run `stty raw -echo; cat > ...`, then sends the payload immediately
after `tmux new-session` returns. Session creation does not prove that the shell has already applied
raw mode. On the failed runner the payload reached the pane during that readiness window, so the tty
retained only the canonical-mode maximum that the test's own comment says raw mode must prevent.

The file is byte-identical at the PR base, MR1 head, and current fetched main: blob
`9525b6d91444ac2226edc112b52bd261cea77e2e`. It contains no model dependency. Both admissible local
runs used the real tmux socket and passed all three cases. This is an unchanged, nondeterministic
tmux setup race that needs its own repair; it is not part of CI6 and was not altered here.

## Required local runs — exact output

The first sandboxed Node 20 attempt was not treated as a test result: the sandbox refused loopback
listeners and the real tmux socket. I repeated the unchanged pre-repair population with host access
on both runtimes. Both produced the same real population:

```text
Node 20.11.1, pre-repair
✓ tests/integration/tmux-literal-send-ceiling.test.ts (3 tests)
Test Files  5 failed | 1 passed (6)
Tests       11 failed | 95 passed (106)
```

```text
Node 22.18.0, pre-repair
✓ tests/integration/tmux-literal-send-ceiling.test.ts (3 tests)
Test Files  5 failed | 1 passed (6)
Tests       11 failed | 95 passed (106)
```

After the five-file expected-value repair, the exact affected population passed on both runtimes:

```text
Node 20.11.1, post-repair
✓ tests/unit/crossModelReviewer.test.ts (45 tests)
✓ tests/unit/modelSwapService.test.ts (29 tests)
✓ tests/integration/model-tier-swap-route.test.ts (19 tests)
✓ tests/integration/cross-model-review-flow.test.ts (3 tests)
✓ tests/unit/modelSwapService-topicProfile.test.ts (7 tests)
✓ tests/integration/tmux-literal-send-ceiling.test.ts (3 tests)
Test Files  6 passed (6)
Tests       106 passed (106)
```

```text
Node 22.18.0, post-repair
✓ tests/unit/crossModelReviewer.test.ts (45 tests)
✓ tests/unit/modelSwapService.test.ts (29 tests)
✓ tests/integration/model-tier-swap-route.test.ts (19 tests)
✓ tests/integration/cross-model-review-flow.test.ts (3 tests)
✓ tests/unit/modelSwapService-topicProfile.test.ts (7 tests)
✓ tests/integration/tmux-literal-send-ceiling.test.ts (3 tests)
Test Files  6 passed (6)
Tests       106 passed (106)
```

Every run used `--no-cache`. Node 20 printed the repository's native-module-health notice because
this checkout's `better-sqlite3` binary is built for Node 22; none of the six affected files uses a
SQLite-backed subsystem, and all 106 assertions completed and passed on Node 20.

## Instrument and dependency identity

- Dependency root: `/Users/justin/Documents/Projects/instar-codey/.worktrees/phaseb-mr1-model-registry-review/node_modules`.
- Lockfile SHA-256: `f08d38d0938c29b0c8302b25d2235e7d6629f108d6c415bcabeb3481d1a33663`.
- Vitest 2.1.9 entry SHA-256: `39db22f579acf5639bbb17a261408debbde03f4692c0c439e77e7f13aeba74d6`.
- Node 20.11.1 executable SHA-256: `7eeb3f01f32235fc4989759a0560ffe9ed0225bdaa9ad1449debb03ff236670e`.
- Node 22.18.0 executable SHA-256: `9187ad22c98cea5b635a79db52fa32ab3f6aa9d41e3abf5da71437cfef1ca9de`.
- No dependency install or rebuild ran.

## Scope and disposition

- Five test files changed, 25 insertions and 25 deletions.
- `tests/integration/tmux-literal-send-ceiling.test.ts` unchanged.
- `src/**`, `scripts/**`, manifests, allowlists, model pins, workflows, and matchers unchanged.
- No test deleted, skipped, or made dual-valued.
- Common ancestor remains `248ed7177f5bf416aa7bdad9763741478195e1fc`; no rebase performed.
- PR #1928 remains a draft awaiting the operator. This report does not recommend or authorize the
  cost-bearing routing decision, undrafting, or merge.
