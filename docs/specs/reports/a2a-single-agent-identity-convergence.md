# Convergence Report — A2A single agent identity

**Spec:** [docs/specs/a2a-single-agent-identity.md](../a2a-single-agent-identity.md)
**Slug:** `a2a-single-agent-identity`
**Converged at:** 2026-10-09 (round 4, the final round under the operator's 80/20 direction)
**Iterations:** 4
**Final-round material findings folded:** 9 (none left open)

## Cross-model review: codex-cli:gpt-5.5 (RAN — round 4)

- **External GPT-tier pass** through the agent's own codex CLI (`gpt-5.5`), verdict SERIOUS ISSUES, six findings — folded where they change the build (below).
- **Clean-door Anthropic second read** (`claude-code:claude-fable-5`, `clean-door-anthropic-review`, not a cross-model opinion), verdict MINOR ISSUES, five findings.
- gemini-cli was installed but not signed in (`gemini-not-authed`), so no Gemini pass ran. grok-build is not enabled.
- Rounds 1–3 were run by two earlier sessions that were killed by a 45-minute session cap mid-round; their external-review outputs were not preserved, so this report records them as **not recorded**. Round 4 is therefore the one round whose cross-model pass is evidenced in full. The aggregated spec-level flag is `codex-cli:gpt-5.5` (one round `ok`, three rounds unrecorded).
- Standards-Conformance Gate (round 4): ran, 92 standards, 1 flag (The Agent Is Always Reachable) — folded, see finding L1.
- Internal reviewers (round 4): six subagents (security, scalability, adversarial, integration, decision-completeness, lessons-aware) on the authoring session's model, Claude Fable 5.1.

## ELI10 Overview

Other agents reach me on the agent network by a fingerprint, like a phone number. For six weeks one of my four machines had its own number and happened to hold my single connection to the network, so another agent's messages went to a number nobody was answering and were dropped a day later. Nothing told either side.

The spec fixes this in five parts: a machine that joins or is rebuilt never invents a number, it adopts the one its siblings agree on; one loud alert when two of my machines publish different numbers; an honest answer to the sender when messages sit queued for hours; a reply from a machine that is not "in charge" gets handed to the one that is instead of being held in silence; and the Files tab stops serving the private key files.

The trade-off: a replaced identity is always a command run on that machine after Justin says yes, never a dashboard ceremony, and the deeper fix (rotating keys, one key per device) is deferred with a named trigger.

## Original vs Converged (round 4 changes only)

- **A lone machine must keep answering Telegram.** Originally a machine with no identity always refused to hold the serving lease. After review it yields the lease only to a sibling that is online and provisioned; a lone machine, a fleet shrunk to one, or a two-machine fleet whose sibling is asleep keeps serving Telegram while it waits for its identity. Why: in the code, every machine that was ever paired runs a real lease, and declining it silences every reply — including the alert asking for the fix.
- **A reply handed to the machine in charge cannot be posted twice.** Originally the hand-off retried three times inside the request. After review the request does one attempt within a fixed budget, records the hold, and the retries run from the recovery tick; a timeout is never retried blind; and when the machine in charge changes mid-hand-off, the old copy is formally superseded before a new one is sent. Why: the old shape could outlast the request's own timeout, and a second copy to a different holder had nothing to deduplicate against.
- **The split alert lives on one machine.** Originally any machine could raise the alert and only the lease holder could resolve it. After review the holder both raises and resolves it, because alerts are stored per machine and a copy raised elsewhere would never close.
- **The alert says what to do when there is no majority.** Originally it assumed one odd machine out. After review, with two values and no strict majority, it proposes no direction and asks which address peers have pinned.
- **The hard-link check now guards the dangerous direction.** Originally a file with extra hard links was refused only inside the `.instar` folder. After review any served file whose inode matches a key file is refused, wherever it is. Both external reviewers found this independently.
- **Smaller build corrections:** refusals on the identity-request verb are signed; the identity is sealed with a domain-separated variant of the secret-sync primitive; the reload lever never connects from a standby and is rate-limited; the ledger sweep covers delivered-but-never-acknowledged rows; the `dark` field on a send reads only the local ledger; the identity lock uses pid plus process start time with a ceiling; a present-but-invalid identity file boots the loud posture; `instar machines remove` prints that the removed host can still sign as the agent; the pool-dark case records the operator's yes on the alert and runs the repair from the named machine's next session; multi-machine posture markers carry the required taxonomy fields.

## Iteration Summary

| Iteration | Reviewers who flagged design issues | Design findings | Precision findings | Spec sections changed | Standards-Conformance Gate |
|-----------|-------------------------------------|-----------------|---------------------|-----------------------|-----------------------------|
| 1 (commit 137a843cd) | not recorded (session killed by the 45-min cap) | not recorded | not recorded | draft → round-1 update | not recorded |
| 2 (commits 279fef6d0, 80a2cf489) | not recorded | cut to five parts (80/20) | — | whole spec restructured | not recorded |
| 3 (commit 4912082d7) | not recorded | 0 (refinements only) | glossary, edge-case ACs | Glossary, Tests | not recorded |
| 4 (this report) | security, scalability, adversarial, integration, decision-completeness, lessons-aware, codex-cli, clean-door | 9 material | 11 minor | §1.1, §1.2, §1.3, §1.4, §2.2, §3.1, §3.2, §4.2, §4.3, §5.1–5.3, Decision points, Multi-machine posture, Frontloaded Decisions, Tests, Rollback, Out of scope | ran (92 standards, 1 flag) |

Round-4 per-reviewer model: internal subagents on Claude Fable 5.1; external `codex-cli:gpt-5.5`; clean-door `claude-code:claude-fable-5`.

## Full Findings Catalog (round 4)

| # | Source | Severity | Finding | Outcome |
|---|---|---|---|---|
| L1 | Standards gate + lessons-aware + integration | material | Lease-ineligibility on an unprovisioned machine silences the operator's Telegram on a lone or shrunk fleet (every paired machine runs a real lease; `authorize` requires it). | Fixed: yield only to a live provisioned peer (§1.1, Decision points, AC1, §4.3). |
| S1 | security | material | A forwarded origin record is bound to the old holder; after a lease move every re-forward is refused `execution-owner-mismatch` and the reply holds 6 h. | Fixed: supersede via the old owner's `receipt`, re-prepare bound to the new owner (§4.2, AC6). |
| S2 | security | material | `POST /agent-identity/reload` could connect from a standby (displacing the awake machine) and was unlimited. | Fixed: re-run the standby/daemon predicate before connect; single-flight + 60 s cooldown (§1.2, AC4). |
| P1 | scalability | material | Settle + 3-attempt ladder inside the reply request exceeds the route's 120 s timeout; a caller re-run mints a new operation id the holder cannot dedupe. | Fixed: one 30 s attempt in-request, hold, ladder from the recovery tick (§4.2). |
| P2 | scalability | material | The 30-day sweep missed `delivered`-but-never-acked rows, leaving `findOverdue` unbounded. | Fixed: sweep every state by `sent_at`; `findOverdue` LIMIT 500 (§3.1, AC5). |
| A1 | adversarial | material | Attention items are per-machine stores; "raise anywhere, resolve on the holder" strands copies and posts N hub messages. | Fixed: holder raises and resolves §2 item; §3 item resolves on every machine over its own store (§2.2, §3.2, posture). |
| A2 | adversarial | material | A transport timeout treated as ladder-retryable double-posts across holders. | Fixed: timeout → `outcome-unknown` → `receipt` to the same holder; retry only on typed non-admission refusals (§4.2). |
| D1 | decision-completeness | material | No rule for the proposed target/source machine when there is no strict majority. | Fixed: minority = target, strict majority = source, no majority = no proposal (§2.2, Decision points). |
| X1 | codex + clean-door + security + adversarial | material | `nlink > 1` refused only under `.instar/` — the one place a hard link to a key never is. | Fixed: refuse any served file whose device+inode matches a never-served file (§5.2, AC7). |
| X2 | codex | minor | Unsigned refusals/`no-handler` could be spoofed on a LAN rope to stall adoption. | Fixed: refusals signed; unsigned = unreachable (§1.2). |
| X3 | codex / clean-door | minor | The shared-key bridge keeps growing without a complexity trigger. | Fixed: any further spec touching adoption rules converts rotation into scheduled work (§Out of scope). |
| X4 | clean-door | minor | One-witness-plus-memory can reinforce a split (both split). | Accepted cost, now stated (§1.3). |
| X5 | codex / clean-door | minor | Relay-side corroboration deferred. | Unchanged: deferred to CMT-026 with a named trigger (decided in rounds 1–3). |
| X6 | codex | minor | `reachable-agree` labelled invariant hides a liveness-vs-correctness tradeoff. | Unchanged: the rule is deterministic at run time; the tradeoff is recorded in Frontloaded Decision 4. |
| X7 | codex | minor | Split the spec into companion specs. | Rejected: the operator named the five parts in one spec. |
| S3 | security | minor | `encryptForSync` is forbidden for credential payloads by its own comment. | Fixed: AAD-bound variant (§1.2, Decision 5). |
| S4 | security | minor | Peer display names reach attention item bodies unescaped. | Fixed: fingerprint prefix + clamped, escaped name in items too (§3.2). |
| P3 | scalability | minor | Send-path `peerDark` scope unstated (a pool fan-out inside a send). | Fixed: local ledger only (§3.2, AC5). |
| P4 | scalability | minor | Detector's OFFLINE source unnamed (would fetch asleep machines). | Fixed: the pool-registry `online` flag (§2.2). |
| A3 | adversarial | minor | Resolve "required set" ambiguous; a revoked-but-running machine could keep the lease. | Fixed: `metadata.contributors`; revoked AND offline to drop out (§2.2). |
| A4 | adversarial | minor | `dark` and the resolve predicate must share one clearing set. | Fixed: `delivered` verdict resolves (§3.2). |
| A5 | adversarial | minor | Lock pid reuse strands `identity-locked` forever. | Fixed: pid + start time, 10-min ceiling (§1.2, Decision 14). |
| D2 | decision-completeness | minor | Present-but-invalid identity file posture unstated. | Fixed: `identity-file-invalid` (§1.1, AC1). |
| D3 | decision-completeness | minor | Which topic to transfer, and unpin afterwards. | Fixed (§1.4, Agent awareness). |
| D4 | decision-completeness | minor | Reply request contract (status codes, timeout floor). | Fixed, superseded by P1's shape (§4.2). |
| L2 | lessons-aware | material | `instar machines remove` says the key is dead; the parent spec requires the opposite notice. | Fixed (§1.4, AC4, rotation trigger). |
| L3 | lessons-aware | minor | `/pool/transfer` answers 503 where the pool is dark. | Fixed: recorded-yes branch (§1.4, Decision 6, AC4). |
| I2 | integration | minor | Rollback claim for §3 was false for agents with the old flag on. | Fixed: revert-only, stated (§Rollback). |
| I3 | integration | minor | Backup exclusion removes a lone machine's only recovery path. | Cost stated (§5.3). |
| I4 | integration | minor | Posture section used a non-taxonomy label. | Fixed: `physical-credential-locality` markers with basis + permanence; lint clean. |

Decision-completeness counts (round 4): frontloaded 15, cheap-to-change-after tags 1, contested and cleared 1. `## Open questions` is `*(none)*`.

## Convergence verdict

Converged under the operator's 80/20 direction (2026-10-09: stop reviewing when findings stop changing the build; no round after this one). Round 4 produced nine build-changing findings, every one folded, and the spec was cut back to 988 lines. Honest limit: a fifth round was NOT run, so a clean re-sweep with zero new findings was not demonstrated; the builders' own review gates and the live proof in §Tests are the next check. The spec carries `review-convergence` with the round-4 cross-model flag.

## Approval

Approved by Justin in Telegram topic 9210 on 2026-10-09: "please proceed as you recommend" (08:31) and "go" for the autonomous build run (10:10). Recorded the same way as `docs/specs/A2A-DURABLE-DELIVERY-SPEC.md` records its autonomous-mode directive. Builders for sections 1–5 are already running in sibling worktrees and merge the tagged spec branch before their first commit.
