# Side-effects review — pool-read selection fix + host-trust consolidation

**Spec:** `docs/specs/peer-credential-guard-tailscale-coherence.md` (converged-tag written
after 18 rounds; operator-ACCEPTED rather than criteria-met — see the spec's `approval-note`).
**PR:** #2286 · **Branch:** `echo/fix-peerurlguard-tailscale-cgnat`

## What changed

- `src/server/peerUrlGuard.ts` — takes a typed `PeerEndpointSelection` with a **required**
  `kind`; imports `ipv4ToInt`/`isRfc1918`/`isTailscaleCgnat` from `PeerEndpointResolver` and
  deletes its own RFC-1918 regexes; adds the named refusal `cgnat-plaintext-unsupported`.
- `src/core/resolveMeshPeerUrl.ts` — adds `resolveMeshPeerSelection` (admission-filtered,
  discriminated result, `refusals` on both branches) and `resolveMeshPeerPreferredSelection`.
  The original single-URL `resolveMeshPeerUrl` is **unchanged**.
- `_resolvePeerUrls()` carries `kind` and prefers the best **admissible** rope.
- All **20** guard call sites updated (the required field made each a compile error).
- Agent Awareness: `src/core/poolReadAwareness.ts`, wired into `generateClaudeMd()` **and** a
  content-sniffed `migrateClaudeMd()` append.

## 1. Over-block — what legitimate inputs does this reject that it shouldn't?

**None identified, and the risk was specifically tested.** The refactor could have over-blocked
in two ways, both covered:

- **Loopback.** The resolver's `isForbiddenHost` FORBIDS `localhost`/`127/8`/`::1` (a peer
  advertising loopback is nonsense); this guard must ALLOW them (loopback here is *us*).
  Importing it wholesale would have regressed that. Not imported; two `TRAP:` tests assert
  loopback stays admitted.
- **IPv6 ULA / link-local.** The resolver has no IPv6 predicates at all, so a naive swap would
  have dropped `fc00::/7` and `fe80::/10` trust (security review 2026-06-12 T-05). Kept local
  to the guard with a comment naming why; a `TRAP:` test asserts each.

Allow/deny behavior is otherwise **identical** to before. The only changed verdict is the
*reason string* for a CGNAT host over http (`scheme-not-allowed` → `cgnat-plaintext-unsupported`),
which was previously misleading rather than wrong-in-outcome.

## 2. Under-block — what failure modes does this still miss?

Stated plainly, because the spec's accepted residual lives here:

- **No destination is authenticated as the intended peer**, before or after. The bearer token
  is the **full** agent API token (`ctx.config.authToken` — the same one `authMiddleware`
  accepts for every authed route, mutations included), not a scoped read credential.
- **Selection can contact a host this code would not have contacted before.** Admission-aware
  selection and health-driven re-selection mean a *fallback* rope from the peer's own registry
  entry may now receive the token. Equivalent exposure for an attacker who controls
  advertisements (their best play — advertise only a hostile RFC-1918 rope — already wins
  today); **a genuine, narrow increase** for a stale address or an attacker holding only a
  fallback host.
- **A dead-but-admissible rope** is only dropped after three *consecutive* recorded failures,
  and the shared health map means a lease success or recovery probe can reset the count — so
  recovery is conditional, not guaranteed.

Remedy specified and sequenced: move peer reads off the shared bearer onto machine-auth **and**
add destination authentication (recipient/method/target binding + authenticated responses).
Request signing alone authenticates the *sender* only.

## 3. Level-of-abstraction fit

Right layer, and this was the most-revised question in review.

- The range arithmetic belongs in `PeerEndpointResolver` (it already owned it) and is now
  imported, satisfying the parent spec's "both validate via the SAME function."
- The admission filter belongs at **selection**, not after it — putting it after is precisely
  the defect.
- A **smarter mechanism already exists** and is deliberately NOT duplicated:
  `HttpLeaseTransport.hedge()` does hedged failover with health feedback and carries a
  hard-won abort-neutrality rule. An earlier draft would have written a worse second copy; this
  change does not touch the lease path at all.

## 4. Signal vs authority compliance

**Compliant.** `isPeerUrlAllowedForCredentials` is a decision point, but it is `invariant` by
design: its inputs are a URL, an operator-configured suffix list, and a signed-registry
endpoint kind — one right answer, no competing signals. A non-deterministic answer here would
make credential egress unpredictable, which is the worst possible property for this gate.

This change adds **no new blocking authority**. It narrows an existing deterministic refusal,
makes its reason accurate, and adds one named refusal. `kind` is **diagnostic metadata** carried so callers can report
*which* rope was skipped; it is NOT an input to the refusal decision — the CGNAT
classification is by host. (An earlier draft of this artifact said the guard uses `kind` to
determine the refusal reason; the second-pass reviewer correctly flagged that as exceeding the
implementation.) Requiring the field prevents a caller forgetting it; it does not establish
endpoint provenance. There is no kind, suffix or scheme
for which a CGNAT host is admitted over http, asserted by a table-driven test over all four
kinds × five suffix sets × four hosts.

## 5. Interactions

- **Shared rope-health map (the one real cross-subsystem risk).** The health map is shared with
  lease traffic, so recording an application error as a dead rope would demote a working lease
  path. Health recording is **transport-only**: connect/DNS/TLS/timeout → `false`; **any** HTTP
  status → neutral; caller-cancel and body-size policy → neutral.
- **Does not shadow or get shadowed.** The guard remains the single admission authority; the new
  selection consults it rather than duplicating it, so the two cannot disagree.
- **No double-fire.** Exactly one rope is selected and one request made per call, as before.
- **`resolveMeshPeerUrl` keeps its existing callers** (the identity mesh-send path layers its
  own transport), so nothing silently changes under them.

## 6. External surfaces

- A pool row that previously read `url-rejected` may now read `peer-unreachable` (new) or
  succeed. Three distinct reasons where there were effectively two.
- Operator-visible: the Agent Awareness section tells a deployed agent not to report
  `url-rejected` and `peer-unreachable` interchangeably, and not to promise an immediate fix.
- **No** new config key, no hook change, no change to who may read a pool surface.
- Timing dependence: the dead-but-admissible recovery depends on the shared health counter and
  is therefore conditional — documented rather than claimed away.

## 7. Multi-machine posture (Cross-Machine Coherence)

- `isPeerUrlAllowedForCredentials` — **unified**: a pure function, identical everywhere, no
  state.
- Endpoint `kind` records — **machine-local BY DESIGN**
  (`machine-local-justification: hardware-bound-resource`), inherited not redeclared: the parent
  spec states peer `endpoints` are machine-local, NOT replicated, NOT proxied-on-read, because
  reachability is observer-relative.
- Candidate ordering + rope health — **machine-local BY DESIGN** (same key). The live evidence:
  the Studio's LAN rope is reachable from a same-LAN peer and dead from the Windows machine. A
  unified ordering would be wrong for every machine but one.
- **No per-machine credential state** introduced. **No** user-facing notice, so no one-voice
  gating. **No** generated URL. **No** new durable state, so nothing strands on topic transfer.
- **Disclosed inherited gap:** conversation *content* still lives only on its holder, so it is
  unavailable when that machine is dark. This change neither causes nor fixes it; the remedy is
  a separate drafted spec.

## 8. Rollback cost

**One coherent commit, reverted as a unit** — `git revert`. The signature change touches 20 call
sites, so a *partial* revert leaves them passing a selection object to a guard that no longer
accepts one: a **compile failure**, not silent misbehavior (the safe direction).

No data migration. No agent state repair. The CLAUDE.md migration is content-sniffed and
idempotent; a revert leaves the added section in place on already-updated agents, which is
harmless prose, and re-running the migration does not duplicate it.

## Second pass

Required — this touches a credential-egress gate ("guard"). See the appended reviewer note.

## Second pass — independent cross-model audit (codex-cli:gpt-6-astra)

**Mechanism, stated honestly:** the audit was run as an independent **cross-model** review
(a non-Claude model, via the agent's own codex CLI) against this artifact plus the guard and
resolver diffs — not as a Claude subagent. That is a stronger form of independence for a
security-relevant gate, and it is recorded here rather than implied.

**Verdict: MINOR ISSUES.** Four findings. Three were accepted and fixed; one is a stated limit
of what was supplied to the reviewer.

1. **`kind` does not name refusals (ACCEPTED, artifact corrected).** §4 claimed the guard reads
   `kind` to determine the refusal reason; it classifies CGNAT by host alone. Reworded above —
   `kind` is diagnostic metadata that callers report, and requiring it prevents an omission; it
   does not establish provenance.

2. **The convenience wrapper discarded diagnostics (ACCEPTED, code fixed).**
   `resolveMeshPeerPreferredSelection` returned only a selection, dropping the refusals on
   success — so a caller could not report which ropes were skipped, which is the exact
   observability whose absence made the original defect invisible. It now returns
   `{ selection, refusals }`, `_resolvePeerUrls()` carries `ropeRefusals`, and a test asserts
   the skipped rope survives the wrapper.

3. **A PRE-EXISTING IPv6 over-admission (ACCEPTED, code fixed — the most valuable finding).**
   The retained ULA regex `/^f[cd][0-9a-f]{0,2}:/` also matched `fc::1` (first hextet `0x00fc`),
   `fd::1`, `fc0::1` and `fd0::1` — all **outside** `fc00::/7`. A credential guard was therefore
   admitting plaintext to hosts outside its own stated private-network policy. Not a regression
   from this change, but I was editing that function, so per the Zero-Failure Standard ("there is
   no such thing as a pre-existing failure") it is fixed here: the quantifier is now `{2}`, with
   negative boundary tests for all four over-admitted shapes plus both ends of the genuine range,
   and the same boundary treatment asserted for `fe80::/10`.

4. **Verification scope (NOT a defect — a limit of the input).** The reviewer was given only the
   guard and resolver diffs, so it could not verify the 20 call-site updates, the migration, the
   predicate implementations, or the tests. Recorded rather than papered over: those are covered
   by `tsc --noEmit` clean, 34 passing unit tests in the two touched files, and the full-suite run
   referenced in the PR. The reviewer's caution about treating a partial diff as whole-change
   verification is correct and worth keeping in mind.

**Disposition: concerns raised and resolved.** The two code findings (2 and 3) changed shipped
behavior; finding 3 made the guard strictly stricter than before this change. The reviewer
explicitly confirmed the destination-authentication gap is correctly distinguished from sender
authentication and is not resolved by this change — which matches §2's disclosure.

## Test evidence, and why CI is the authority here (stated rather than glossed)

**Targeted tests: 34 passing** across the two touched files
(`tests/unit/peer-url-guard.test.ts` 19, `tests/unit/resolve-mesh-peer-url.test.ts` 15),
including the 1500-address property sweep, the §2 trap cases, the IPv6 ULA boundary cases, and
the admission-aware selection regression. `tsc --noEmit` clean. Also
`tests/unit/feature-delivery-completeness.test.ts` 210 passing after registering this
capability in the CLAUDE.md parity list AND the framework-shadow markers.

**The local full suite did NOT complete green, and the reason is host capacity, not this
change.** Recorded honestly:

- Three full-suite attempts were made. The first two were killed (a systemd server restart took
  every tmux session on the machine down with it; see the accreted defect list). The third was
  stopped by me deliberately, because the box was saturated and my own server had become
  unresponsive (`/health` HTTP 000 at 25s, later 200 in 13.6s).
- Measured cause: this 10-core machine was running my suite PLUS 17 `vitest` processes under a
  separate `train-119` codex session PLUS 4 assembly-test processes, at 92-95% CPU and load
  12-14. I capped my own run to `--maxWorkers=2`, then stopped it entirely; the box stayed
  saturated from the other sessions, which are not mine to kill.
- The only failures seen were **timing** assertions, and a **different one each run**: run 1
  "10 consecutive hook invocations within 3s" at 3604ms; run 3 "Stop hook within 500ms" at
  1008ms. Neither touches any code path in this change (this change has no hook surface).
- **Independent corroboration:** the concurrent `train-119` session hit the same class of
  failure on *its* unchanged test files ("200-turn p95 timing bound: 1439ms versus 1000ms") and
  recorded them as host failures. Two sessions, different files, same signature.

**CORRECTED: the LOCAL full gate is the verification path, not CI.** An earlier draft of this
section said CI would be treated as authoritative. That was wrong for this repo and the claim was
checked rather than assumed: `GET repos/JKHeadley/instar/branches/main/protection` returns **404**
— there is no branch protection on `main`, so there are **no required checks**. CI workflows do
run and do produce signal (several gates green at the time of writing), but nothing *requires*
them, and the standing rule is that the local full gate is the verification.

So the Zero-Failure Standard is satisfied the only way it can be here: **a green local full-suite
run**, which this change waits for. The suite is re-run once the host is quiet (the concurrent
`train-119` codex suite has since finished and load is back to OK), and CI is treated as
corroboration rather than the gate. **The PR stays HOLD-marked until a local full-suite run is
green**; any failure attributable to this change is mine and gets fixed before merge.
