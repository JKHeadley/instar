# Side-Effects Review — Quiet by Default completion

**Version / slug:** quiet-by-default-completion
**Date:** 2026-11-05
**Author:** Echo
**Second-pass reviewer:** independent correctness, storage, and conversation-floor reviewers; all concurred

## Summary of the change

Tier 2 completion of #2738 against the approved notification-selectivity spec. This closes routine automated egress outside the Agent Health slice (#2739): a structural gate, bounded quiet store/feed, confirmed preferences and pool fan-out, reply/floor provenance, origin relay/recovery receipts, sender census lint, and overseer/self-heal guidance. Fresh canonical worktree `/tmp/instar-2738`, initial base 09e59eb50 (v1.3.1679), refreshed conflict-free to canonical main 0365aa8da (v1.3.1681), origin https://github.com/JKHeadley/instar.git. The sandbox permits /tmp but not the normal agent-home worktree destination, so a fresh bare clone plus linked worktree provides isolation. No sessions or test agents are launched on the laptop. Tests use mocked transports and database workers.

## Decision-point inventory

- Delivery disposition: added structural policy at adapter/library and mandatory origin execution; no text matching.
- Reply provenance: modified trusted reply seam and signed origin carrier. Job authors cannot obtain replyhood by omitting metadata.
- Conversation floors: specific admitted inbound binding; command responses are single-use for new messages. Login completion edits its actual delivered command receipt.
- Quiet success: added a distinct recorded receipt and terminal origin suppression with a durable quiet id.
- Push preference: sole writer with PIN/recent operator confirmation and authenticated peer intents.
- Push budgets, episode dedup, digest and failure escalation: bounded, with single-use local permits for already-decided summaries/failure notices.
- Existing tone authority, ownership authority, triage authority and lifecycle safety floors: passed through.

## 1. Over-block

An unstamped direct sender becomes quiet under enforcement. This is intentional for automation, but genuine response seams must carry verified or inbound-bound provenance. The census covers existing callsites; the tests cover late verified replies, commands, cold-map loss floors and answered presence. Login progress was consolidated into one actionable URL message and a receipt-bound completion edit. Recorded outcomes return before reply/injection/delivery bookkeeping. Source-specific scopes prevent an unrelated routine emitter from inheriting an inbound response capability.

## 2. Under-block

In-process code is trusted and constrained by the source lint and review, matching existing safe-executor trust. HTTP body fields cannot mint reply capability. Same-agent signed origin records carry provenance across the mesh and the holder classifies again. Legacy session-authored signed records retain the reply floor, while explicit automation remains automation. Push budgets are process-local in memory and reset on restart; existing transport and origin capacity floors remain load-bearing. The spec already tracks lease-coordinated pool budgets in CMT-1951.

## 3. Level-of-abstraction fit

Routing belongs at egress and final origin execution, not at individual monitor wording. Content stays under the tone authority. The lifeline delegates automation to the server writer and retains it in its existing outbox while that authority is unavailable, preserving the single quiet-store writer.

## 4. Signal vs authority compliance

Required reference: [signal-vs-authority](../../docs/signal-vs-authority.md).

The gate evaluates the closed structural domain: source capability, signed origin, declared category, operator opt-in and bounded budgets. It never interprets message text. Stale-session probes feed the existing triage authority; no new heuristic grants restart or kill authority.

## 4b. Judgment-point check

No new static heuristic at a competing-signals judgment point. The structural delivery policy is enumerable. Diagnosis and recovery remain with existing authorities.

## 5. Interactions

Quiet receipts terminate retries and do not represent Telegram acceptance. Suppressed origin operations retain a quiet receipt for logical replay and are removed from recovery memory. Per-operation decision caching keeps a failed delivery from spending a command, significant episode or budget twice. Hub/mobile-push bookkeeping runs only on actual delivery. Reap and spend outcomes distinguish quiet-recorded from sent; the legacy delivery sentinel stops without a recovered marker or delivery counter. Enforced spend delivery uses the mandatory origin durable outbox rather than a second legacy queue. Distinct response stampers keep routine emitters from inheriting command authority. Lifecycle floors preserve user reachability while automation waits for the notification writer.

## 6. External surfaces

Telegram becomes quieter; the dashboard exposes quiet notices and confirmed category choices. Pool reads clamp peer fields, cap work and identify unavailable machines. Bodies render through textContent. Acks route back to the owning machine. Preference writes are audited and pending cross-machine delivery is durable. No destructive operator action is added.

## 6b. Operator-surface quality

The Notifications page leads with unread notices and Mark read actions, followed by visible category switches. It uses human category descriptions and text-rendered bodies rather than raw JSON. Tap targets are at least 44px, rows wrap at phone width, and error text says when a machine or write is unavailable. A PIN confirmation is required to change push preferences. Delete/revoke actions are absent.

## 7. Multi-machine posture

Quiet records are machine-local by design and proxied on read through the pool feed and bounded session-context pull. They remain on the producing/holding machine and stay visible after topic transfer when that machine can answer. Dark machines are explicitly unknown. Confirmed category changes fan out as durable authenticated machine-qualified intents; bounded attempts stop until an observed offline→online transition rearms them. Offline state is durable; successful polling alone cannot reset attempts. Eligible intents are selected before the 16-item batch so exhausted work cannot starve newer choices. Final holder execution reapplies policy and carries signed provenance. The shared Attention hub remains the push destination. New status is `/notifications/selectivity`, explicitly this-machine, with pending preference peers; feed scope and unavailable peers are explicit. No other status verdict is widened to a pool claim.

## 8. Rollback cost

Set dryRun true (preferred) or disable selectivity in live config, then revert the source change if required. Quiet records and terminal receipts remain readable audit data. No destructive migration or constitution edit. Echo's one-time directive marker prevents a restart from undoing a subsequent deliberate rollback.

## Producer audit

- Stranded topics: the detector remains signal-only. OwnershipReconciler/StaleOwnerReleaseEngine own bounded evidence, release and claim attempts. Quiet attention records carry affected topic ids into session context; no needsUser escalation is fabricated.
- Peer visibility: existing grace, episode and flap brakes remain. WorkingSetPullCoordinator's returning-peer drain owns recovery. Notices report automatic re-fetch rather than asking the person to bring or un-revoke a peer as routine housekeeping.
- Stale sessions: liveness, transcript and CPU probes precede a once-per-episode call to the existing bounded triage authority. Its result is recorded before attention. No new auto-kill authority and no "reply check session" instruction.
- Pins: TopicPlacementPinStore/fold/quarantine and the existing reconciliation paths retain ownership of pin repair. Quiet routing does not grant unpin/restart authority. No routine pin observation gains needsUser or significant-class status.
- Overseers: shipped built-in templates and init instructions keep routine findings/repairs in handoffs and require an unresolved impact plus one operator-only action for a Bugs-hub post. Built-in refresh applies the shipped template to existing installations.

## Implementation reconciliation

The store immediately appends the first occurrence, then batches repeat counts into at most one update per coalescing window. This is two bounded physical events per repeated window rather than the spec's original single delayed row. It protects the first occurrence from process death while retaining O(windows), not O(events), writes. Tests cover concurrent storms, restart/ack ordering, torn tails, large-snapshot compaction and cursor ties. This is an explicit durability implementation adjustment, not omitted work.

## Class-Closure Declaration

Defect class: unbounded-self-action. Closure: guard. The source provenance lint and zero-stray transport tests detect a routine producer regaining delivery by omission. New repeated effects have a cadence, cap and settling brake: overflow is once/window; digest once/day; failure escalation max 3/day with 6h episodes; preference retries max 8 until peer return. Recovery owns durable suppressed receipts instead of re-driving recorded automation.

## Second-pass review

All three independent reviewers concurred after corrections. Correctness review found the browser executor bypass and terminal replay edge; both now share origin classification and durable suppression with bot delivery. Conversation-floor review found the cold-start helper dropping its inbound binding; the narrowed helper and actual forwarded stop-ack path are covered. Storage review found version ordering, restart/ack ordering and retry fairness issues; the final durable offline→online rearm and eligibility-before-batch fix passed review. No constitution files changed.

## Evidence pointers

Targeted unit tests currently cover zero-stray bursts, concurrency, restart persistence, pagination, provenance, PIN/operator consent, durable preference fan-out and real origin-store suppression/replay. Final counts, lint and CI results are recorded in the PR and build summary after verification.

## Verification and release boundaries

Local verification uses mocked Telegram transports, session descriptors and disposable database workers only: 1,111 targeted unit tests passed (one existing skip), 99 integration tests passed, and 41 origin/browser lifecycle tests passed. The final parity test was rerun separately after correcting its test-only producer scope assertion. All 52 lint steps and native TypeScript checks passed. Stage-B certified code/evidence fingerprints are unchanged; five outbound notification dependencies are explicitly partitioned out because they do not alter certified inbound Codex composer delivery.

The ordinary pre-push hook remains installed. Its broad Threadline agent-server lifecycle collection is left to GitHub CI under the user's explicit prohibition on starting laptop sessions/test agents; only the documented scoped-e2e environment switch is used for that collection, and every remote required check must pass before safe-merge. The smoke runner retains its own breadth limits. No session-starting local verification lane is requested. The full fleet operator flip, lease-coordinated budgets and legacy removal retain their existing approved tracked rollout items (CMT-1941, CMT-1948, CMT-1951); this change does not claim a completed 14-day production soak. Durable per-machine soak counters reset conservatively after an unclean shutdown and never auto-flip the fleet.

The existing PA-5 update-promotion authority is preserved: a real authenticated upgrade-notify job with a bounded, parseable pending guide containing audience:user can carry its existing entitlement through the signed origin record. Ordinary job/body metadata cannot mint it. An explicit category disable wins; normal category/global budgets still apply. This avoids requiring a second opt-in after release promotion. Regression tests cover unpromoted/other jobs and actual signed session delivery.

Fixed conversation-serving floors are shown in status but do not have misleading push switches: the dashboard hides them and the preference route refuses floor mutations, even with PIN confirmation. Their inbound-bound protection remains automatic. Public feature documentation covers the feed, confirmed preferences, delivery receipts and rollout; the documentation coverage and repository-invariant gates pass locally.

Production registration intentionally passes routes a read-only live-config handle. The preference route now checks its actual sole-writer capability, not a stripped config setter, and optionally verifies read-back through get. The get-only route regression passes locally. A new production AgentServer PIN-unlock/preference lifecycle test is CI-owned and was syntax-checked without importing or starting a laptop test agent. Independent storage review concurred with this correction.

Final consumer closure: batches retain producer/category identity, terminal quiet receipts remove frozen work without send counters, and derived mobile pushes observe real delivery only. Window reports, scheduler alerts, feedback triage, key-health episodes, peer relays, collaboration notices and sentinel callers preserve recorded outcomes without claiming notification or retrying them as failed transport. Key rejection alone remains ordinary automation; the significant lane is not broadened beyond the approved whole-agent failure definition. Actual affected-person notices retain specific-inbound floors. Replacement keys reset prior quiet receipt state.

CI corrections keep the same production admission: origin HTTP fixtures now supply the session lookup they exercise and send mocks return actual SendResult values. The new lint is ratcheted in the required-lint inventory. Lifeline normalization precedes its inbound topic read. Notifications renders an adopted two-tile summary, without expanding grandfather exceptions. These regressions receive targeted mocked tests; the production AgentServer preference lifecycle remains CI-owned.

Final transport retry review: a quiet origin receipt is terminal in both formatter branches; it cannot trigger a plain-text resend or duplicate quiet row. MessagingAdapter.send retains its pre-existing parse-rejection-only retry rule. Growth digests record quiet-recorded, never sent, and retain the existing terminal window/cadence accounting. Direct mock-API regressions prove one attempt for quiet/403 and two only for a rejected400 parse. The conversation-floor reviewer concurred after this correction. Existing route fixtures now return SendResult and supply session lookup explicitly; production authorization is unchanged. Silent-fallback ratchet remains494; durable pending status, bounded writer fallback health, unavailable peer context and logged advisory failures explain the narrow annotations, and peer persistence errors now log rather than disappear.

Latest main reconciliation (v1.3.1682) preserves both the notification awareness migration and sign-in profile protection, including both reviewed outbound/non-composer Stage-B dependency exclusions. Certified code and evidence remain unchanged.

The merged main introduced additional public capability inventory. Architecture documentation now explains the gate/store/preference components and corrects legacy urgency wording so immediate scheduling cannot be mistaken for push entitlement. Documentation thresholds remain unchanged.
