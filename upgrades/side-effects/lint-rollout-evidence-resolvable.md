# Side-effects review — rollout-evidence CI ratchet

**Change:** a lint that fails the build when a spec declares `rollout-disposition: active` with
`rollout-evidence-type: endpoint` and names a `rollout-evidence-ref` whose route does not exist in
`src/`. Wired into the `npm run lint` chain. Ships with a two-entry accepted-findings baseline.

**Earned from:** a sweep on 2026-07-27 of all 5 rollout-active specs found **2 whose evidence
endpoint did not exist — 40%**:

- `claim-verification-sentinel` named `/completion-claim-verification/stats`, a prefix that never
  existed, while `CompletionClaimVerifier.stats()` sat implemented and called by no route. The
  verifier had been recording for weeks with its graduation criterion unreadable. Fixed in #1682.
- `mutual-ssh-autobootstrap` named `/multi-machine/mutual-ssh`. Its feature PR (#1539) merged
  2026-07-21; the endpoint never landed with it. Still open — ACT-1398.

Both had identical effect: rollout marked active, criterion unevaluable, feature parked
indefinitely, nothing surfacing that it was stuck. Neither was discoverable without going looking.

## 1. Over-block — what legitimate change does this reject?

A spec whose endpoint is assembled dynamically — a template-literal path, or a router mounted
under a prefix declared elsewhere — will not string-match and would fail. That is a real
false-positive class, and the escape is explicit rather than silent: add a `KNOWN_UNRESOLVED`
entry stating why. The cost of the false positive is one deliberate line and a reason; the cost of
the false negative it replaces is a feature parked forever.

It cannot block anything at runtime. It is a build-time check over documentation frontmatter.

## 2. Under-block — what does this still miss?

- **Only `type: endpoint`.** `file` and `metric` evidence types are unchecked. Extending is a
  separate change; claiming this closes the class would be the overclaim the lint exists to catch.
- **String match, not a live probe.** A route string present in `src/` but never mounted, or
  mounted behind a flag that is always off, passes. This proves the path was *written*, not that it
  *answers*. A live probe would need a running server and would make the lint environment-dependent.
- **Regex frontmatter parse.** A folded or multi-line scalar ref is invisible and the spec is
  skipped rather than failed — the safe direction for a crude parser, and stated in the header.

## 3. Level-of-abstraction fit

Correct layer, and deliberately the cheapest one that works. The alternative — a runtime check that
probes each rollout endpoint — would be more thorough and would fail for environmental reasons
(server down, feature dark) that have nothing to do with the defect. A build-time string check is
explainable, deterministic, and fails only on the thing it names.

Placement in the `lint` chain (not a separate CI job) is what makes it un-skippable: the same
chain already runs 30 sibling lints, and a guard in its own optional job is a guard that gets
disabled.

## 4. Signal vs authority compliance

This is a **deterministic gate**, not an LLM one, and it gates a build rather than a runtime
action. That is the class where a hard block is appropriate: the check is a literal string match
with no judgement, its failure mode is a named false positive with a one-line escape, and being
wrong costs a developer sixty seconds rather than a user anything.

The `KNOWN_UNRESOLVED` list is the *accepted findings ledger* the converging-audit standard calls
for — and assertion C makes it shrink-only, so it cannot become a parking space.

## 5. Interactions

- **Assertion C is the anti-rot mechanism.** An entry whose ref starts resolving becomes an error,
  forcing deletion. Without it, a stale accepted-finding would mask a future regression at the same
  path — the allowlist would silently become the bug.
- **The claim-verification baseline entry is deliberately self-expiring:** #1682 fixes that ref, so
  the moment it merges, assertion C fails until the entry is removed. The ratchet cleans itself.
- **No interaction with the runtime rollout machinery.** It reads spec frontmatter and `src/` text;
  it does not import, execute, or consult any feature.

## 6. External surfaces

None. A build-time lint. No route, no config, no persisted state, no user-visible behaviour.

## 7. Multi-machine posture (Cross-Machine Coherence)

**Not applicable by construction, and stated rather than assumed.** This is a build-time check over
repository contents. It introduces no state, no notice, no generated URL, and nothing that could
differ between machines — the repository is the same artifact everywhere it is checked out. There
is nothing here to replicate, proxy, or strand on a topic transfer.

## 8. Rollback cost

Delete the script and its entry in the `lint` chain. Nothing else references it.

## Evidence

The guard was verified by **reverting the conditions and watching it fail**, because a guard that
passes proves nothing:

```
A — drop the mutual-ssh baseline entry:
    FAIL, names the spec, the ref, and the three ways to resolve it.   exit 1
C — allowlist a slug that DOES resolve:
    FAIL, "now RESOLVES ... delete that entry".                        exit 1
clean repo:
    "5 rollout-active endpoint spec(s), 3 resolving, 2 accepted."      exit 0
```

Exit codes were checked directly rather than through a pipe — a lint that prints FAIL and exits 0
is a lint CI ignores, which would have made this whole change decorative.

Tests: 6 passing, and the load-bearing one asserts the lint **is wired into the `npm run lint`
chain**. A guard not in the chain never runs, which is the same defect class the guard detects.
The tests also assert the lint reports a non-zero denominator — a scan of nothing must not read as
a pass.
