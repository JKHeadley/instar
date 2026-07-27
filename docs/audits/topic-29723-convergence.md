---
audit: "topic-29723-convergence"
target-pattern: "Every goal, directive and open thread the operator stated in topic 29723 since 2026-07-25, verified against LIVE state rather than against the agent's recollection — plus the failure class those threads keep re-deriving."
search-surface: "All operator messages in topic 29723 from 2026-07-25 to present (392 messages in window, 41 from the verified operator); the live registries each thread's claim is checkable against — /channels, /conformance/coverage, /evolution/actions, /commitments, docs/specs/*.md rollout frontmatter, and the merged PR record on main."
rounds: "2"
---

# Audit — Convergence-to-Coherence over topic 29723

**Trigger:** Operator directive (topic 29723, 2026-07-27 17:30Z), verbatim: *"we are back to
re-discovering many of the things that have already been stated in this topic … I'm going to apply
our 'recursive convergence to coherence' standard to this topic itself … Completion/success means
that you review this topic history and can apply an audit to convergence to verify that ALL goals
have been met and all the threads have been closed."*

**Convergence criterion:** a re-sweep of the full operator-message surface adds no new open thread
AND every enumerated thread is in a terminal state (`met`, `superseded`, or an operator-ratified
deferral).

**Why this ledger exists as a git-tracked file rather than a chat message.** The operator has
re-grounded this topic by hand on 2026-07-23, 2026-07-26 and 2026-07-27. Each re-grounding produced
its findings in a Telegram message, which scrolls away — which is precisely why the next
re-grounding re-derived them. Round 1 of this audit was itself published only as a rendered private
view, and so committed the same error it documents. Per *Close the Loop — Untracked = Abandoned*, a
re-grounding whose only output is prose is a re-grounding that will be repeated.

---

## Round 1

Search angles: every operator message in topic 29723 since 2026-07-25 (`/topic/search`, 392 messages
in window, 41 operator-authored); each stated goal cross-checked against the live registry that
would answer it — `GET /channels`, `GET /conformance/coverage`, `GET /evolution/actions`, the
`docs/specs/*.md` frontmatter, and the merged-PR record on `main`.

Surface delta: initial sweep — the surface is the operator-stated thread set (13 threads) plus the
failure class those threads share. Round 2 must re-verify each thread against live state (a status
asserted from recollection is the same defect the audit is about) and re-sweep for operator
messages arriving after this round.

**The finding that reframes the rest: every failure in this window is one failure class — the thing
existed and was not consulted.** Four instances, all inside 2026-07-27, each checkable in under a
minute against a registry, a store, or a file, and in each case a *label* was trusted over the
*artifact*.

| location | behavior | bucket | disposition |
|----------|----------|--------|-------------|
| git global config (`url.*.insteadOf` credential rewrite) | Agent claimed "I can't push to GitHub — this needs a credential only the operator can produce". A dead token was baked into a URL rewrite, which structurally prevented git from ever consulting the working `gh` login sitting beside it. The fix was a config change entirely within the agent's own permissions (Self-Unblock Rung 0). Cost: the operator had to say "just fix it"; the fix then took ~15 min. | consultation-gap-credentials | fixed: repo remote repointed at the CLI login; PRs #1674–#1677 pushed same session |
| src/core/channelRegistry.ts (`a2a-telegram` row) | Agent claimed "Codey isn't working" and reported a peer agent as broken. `GET /channels` already recorded that channel as `state: half-built, direction: receive-only` — *"the outbound send function has no executing caller, so this channel can receive but cannot send"*. The registry was built at the operator's own request on 2026-07-26 and never read. Cost: ~2h re-deriving a documented limitation; weeks of a silently dead mentor channel. | consultation-gap-registry | fixed: channel proven live 2026-07-27 via the operator's Telegram account; handoff contract adopted |
| SemanticMemory entity *Telegram bot visibility limit* (recorded 2026-07-19T17:20:23Z) | Agent presented "Telegram never delivers a bot's messages to another bot" as a fresh discovery. Its own semantic store had recorded that limit in substance eight days earlier. Capture was not the gap — capture worked; retrieval never surfaced it. | consultation-gap-memory | fixed: PR #1680 (recall returned zero rows for any natural-language query — FTS5 implicit-AND over raw sentences) |
| docs/specs/periodic-goal-realignment.md | Agent claimed the goal-realignment spec was "an unconverged draft three days old" after reading the PR *description* ("DRAFT — awaiting convergence") instead of the file, whose frontmatter read `status: converged`, 6 rounds, cross-model reviewed, dated 2026-07-24. It then spent ~90 min re-converging it to a strictly weaker document. The correction to this initially carried a false consolation ("it found eight things the first pass missed" — it found one). | consultation-gap-artifact-vs-label | fixed: canonical 2026-07-24 spec restored; the re-run's single real hardening folded in; two actions filed on the false premise cancelled |
| docs/STANDARDS-REGISTRY.md:316 (`B16_UNVERIFIED_WALL` exemptions) | The one standard with real structural enforcement is *A Wall Is a Hypothesis*, enforced by B16 — and B16 passed BOTH morning failures through its own exemption list ("a credential, an account connection"; "a genuine runtime error / blocker"). The exemption predates the Self-Unblock standard, which says a credential the agent can already reach is the FIRST place it must look, not an external constraint. The guard worked exactly as written; the rule's escape hatches are the hole. | enforcement-exemption-self-contradictory | deferred: ACT-1343 |
| GET /conformance/coverage | The registry declares 81 standards; the enforcement audit covers 22; of those, 21 are `documented-only` and 1 has a structural guard (`enforcedRatio 0.0455`). On that base rate a new standard has roughly a one-in-twenty chance of becoming anything other than a wish — which is the argument against answering this window's findings with standard number 82. | enforcement-base-rate | accepted: measured and reported; the response is to build guards for existing standards, not to add another standard |
| GET /evolution/actions | 821 pending, 26 completed ever, 537 cancelled — all 537 carrying the identical resolution *"Abandoned without active tracking since creation date (3+ weeks); committing to closure per Deferral=Deletion."* That is a bulk write-off, not closure: the queue drains by things getting old, not by things getting done. Same day: 77 created, 6 completed; of the pending, 493 `high` and 51 `critical`. Filing an intention costs one API call and buys the feeling of having handled it. | filing-outruns-finishing | deferred: ACT-1343 |

New findings this round: 7

## Round 2

Search angles: (a) re-swept the operator-message surface for anything arriving after Round 1 closed
(one new message, 2026-07-27 18:12Z — the blanket pre-approval); (b) re-verified every Round-1
thread status against LIVE state rather than against Round 1's own prose — `GET /conformance/
coverage/health`, `GET /evolution/actions`, `GET /commitments`, `GET /machines/ssh-health`,
`GET /completion-claim/stats`, `gh pr checks` on every open PR, `git log origin/main`; (c) swept the
class Round 1 named — "a rollout marked active whose evidence readout does not resolve" — across
every `docs/specs/*.md` carrying rollout frontmatter, rather than fixing only the one instance that
surfaced.

Surface delta: the operator surface grew by ONE message, which both unblocked the highest-leverage
Round-1 thread and opened a new one (alignment-verified self-approval). The *technical* surface grew
materially: Round 1 named the consultation class from four conversational instances; Round 2's
class-sweep found the same class in the ship process itself, in 2 of 5 rollout-active specs — a
population Round 1 could not see because it was looking at conversation, not at frontmatter.

| location | behavior | bucket | disposition |
|----------|----------|--------|-------------|
| docs/specs/*.md (`rollout-evidence-ref`, 5 rollout-active endpoint specs) | Class-sweep of the Round-1 pattern in the ship process: 2 of 5 rollout-active specs (40%) named a graduation-evidence endpoint that returns 404. Identical effect both times — rollout marked active, graduation criterion unevaluable, feature parked indefinitely, and nothing distinguishing "stuck" from "being careful". Neither was found until someone went looking. | rollout-evidence-unresolvable | fixed: PR #1682 (route built) + `scripts/lint-rollout-evidence-resolvable.js` wired into the `npm run lint` chain, so a rollout can no longer claim evidence that does not exist |
| scripts/lint-rollout-evidence-resolvable.js (`KNOWN_UNRESOLVED`) | The guard's baseline of accepted findings is the obvious rot vector — an allowlist becomes permanent parking. Made shrink-only: an entry whose endpoint starts resolving becomes an ERROR demanding its own deletion. This fired for real on its own author within the hour: #1682 merged, the rebased lint immediately failed itself and refused to pass until the now-resolving entry was removed. | guard-anti-rot | fixed: shrink-only assertion + 6 tests, the load-bearing one asserting the lint IS in the lint chain (a guard outside the chain is the defect class it detects) |
| docs/specs/mutual-ssh-autobootstrap.md:14 | Second-order instance of the audited class, committed WHILE auditing it. The 404 on `/multi-machine/mutual-ssh` was diagnosed as "the endpoint never landed with the feature (#1539, merged 2026-07-21)". The readout had landed — as `/machines/ssh-health`, wired the whole time, returning real data (`enrollmentState: ssh-bootstrap-blocked`, `pairs[0].mutual: false`). The spec named a path that never existed. Absence was concluded from one lookup instead of checking whether the thing exists elsewhere — the exact error the audit is about. | consultation-gap-second-order | fixed: `rollout-evidence-ref` corrected to `/machines/ssh-health`; ACT-1398's premise corrected |
| .github/workflows/eli16-pr-gate.yml | PR #1661's eli16 check failed, and re-running it could never succeed: a workflow re-run replays the ORIGINAL event payload, so a gate that reads `github.event.pull_request.body` re-reads the stale body forever. A re-run that cannot succeed is output-identical to a genuine persistent failure. Compounding it, a local pre-check for the substring "ELI16" passed while the real checker (which requires an `## ELI16 — …` heading) failed — verifying with the wrong tool, again. | rerun-cannot-succeed | fixed: body corrected after running the REAL checker locally against the live body; verified by read-back per `gh pr edit exits 0 while failing` |
| tests/e2e/feedback-inbox-lifecycle.test.ts | A test race blocked two unrelated PRs (#1682, #1683) on a red check. The drain writes the durable row and THEN clears the inbox; the test polled only for the row, so under CI load it read a stale inbox count. `safe-merge` correctly REFUSED both merges rather than waving a red check through — the gate behaving as wanted even when inconvenient, which is why this needed fixing rather than re-running. | flake-blocking-real-work | fixed: PR #1684 — polls for BOTH effects, zero assertion lines changed, so an inbox that genuinely never clears still fails |
| src/core/StandardEnforcementExtractor.ts:46 | **Round 1's headline number was wrong, and I reported it to the operator.** Round 1 recorded "81 standards, 22 audited, 21 documented-only, 1 with a structural guard" and drew a base rate from it: *a new standard has about a one-in-twenty chance of becoming anything other than a wish.* The premise does not hold. `FILE_RE` only extracts a guard reference from a **backticked** path; a standard that names its enforcement in plain English yields zero refs and is classified `documented-only`. Verbatim from `docs/STANDARDS-REGISTRY.md:371` (Zero-Failure): *"Enforced structurally: Husky pre-push hook, CI branch protection, session-level test-health gate."* — three real guards, no backticks, classified as a gap. Two of those refused my own work today. So does the Side-Effects Review Gate's `scripts/instar-dev-precommit.js`, which blocked my commit three times, and the `decision-audit` CI job, which failed PR #1687. The repo holds 32 lint scripts and 18 ratchet tests. The true statement is *"only one of 22 audited standards NAMES a guard in a form the extractor recognises"* — not *"only one standard is enforced"*. `enforcedRatio` and `gaps` are named in a way that invites exactly the misreading I made. | metric-misread-as-coverage | fixed: corrected here and to the operator; the remediation (link each standard's prose to the guard already enforcing it, and rename the surface so it says what it measures) is the next unit of work, not a new standard |
| topic 29723, operator message 2026-07-27 18:12Z | New thread opened by the same message that closed the oldest one: *"I'm tired of things getting lost and falling behind because it needed an approval … a system that reviews a draft/spec/decision against our north star and hierarchy of goals and verifies alignment … accept my pre-approval for any previous or future decisions that need me during this autonomous session."* Distinct from the goal-realignment thread: that one detects drift in what the agent is DOING; this one authorises a decision the agent is ABOUT to make. The alignment-scoring surface for it already exists (`/intent/org/test-action`, `/intent/alignment`) and currently grades the agent's own decisions F — largely because 18 decisions recorded 18 bespoke one-off principles, scoring zero on consistency. | new-thread-self-approval | deferred: ACT-1343 |
| docs/specs/periodic-goal-realignment.md:8 | The Round-1 highest-leverage thread — blocked on one line (`approved: true`) since 2026-07-24 while the failure it prevents recurred three times — is now UNBLOCKED under the blanket pre-approval, stamped with its provenance, and in build with the peer agent. The boundary was stated rather than assumed: the pre-approval is not treated as authority for PIN-gated actions, spend, or irreversible outward effects. | thread-unblocked | fixed: `approved: true` + `approved-by` provenance on the converged 2026-07-24 spec; Phase 1 build handed to the peer agent |

New findings this round: 8

## Convergence status (honest)

**NOT CONVERGED after 2 rounds, and it must not be reported as converged.**

Round 2 added seven findings, not zero — and one of them (the mutual-ssh mis-diagnosis) is a fresh
instance of the very class under audit, produced *during* the audit. That is the strongest available
evidence that the class is not closed: it is still generating instances in the same session that is
documenting it.

**What is MERGED since Round 1, and what is only in flight** — separated deliberately, because the
first draft of this paragraph listed four things as "genuinely closed" when exactly one of them was
merged. Writing "closed" for work sitting in CI is trusting a label over the artifact, in the audit
about trusting labels over artifacts.

MERGED on `main` — three:

1. PR #1682 — the claim-verification rollout-evidence endpoint.
2. PR #1684 — the E2E race that was blocking two unrelated PRs on a red check.
3. PR #1661 — a staleness check whose remediation text named an impossible action.

IN FLIGHT, not closed — five open PRs with CI running at the time of writing:

4. PR #1688 — the rollout-evidence ratchet, the thing that makes the class un-reintroducible.
5. PR #1685 — the mutual-ssh evidence-ref correction, the second instance of the class.
6. PR #1683 — recall retrieving semantically instead of by keyword, Thread 12's core.
7. PR #1687 — the pre-push gate refusing every clean post-release push.
8. PR #1686 — this ledger.

Not code at all: the goal-realignment thread is **unblocked and in build with the peer agent** —
which is progress, not closure, and must not be reported as closure.

What remains open: the enforcement-linkage gap (only 1 of 22 audited standards names its guard in a
machine-recognisable form, while ~50 real guards sit on disk unlinked — see the Round 2 correction);
the
filing-outruns-finishing ratio is unchanged; the councilor pair remains scoped and unbuilt; Slack as
the peer agent's user surface still has no end-to-end user-driven proof and so fails *Live-User-
Channel Proof Before Done*; and the new self-approval thread is one message old.

A third round is required, and its honest precondition is that at least the consultation class stops
producing new instances — measured, not asserted.
