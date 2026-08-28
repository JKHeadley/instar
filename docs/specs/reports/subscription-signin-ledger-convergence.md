# Convergence Report — Subscription Sign-In Ledger

*In progress after round 43 and an external architecture reset. The pool-authority foundation is
now a separately reviewed prerequisite; source implementation remains gated pending convergence
of both documents and subsequent quiet rounds. This file is
the durable home for review history so the spec itself stays normative.*

## Authoritative current-state ledger

This block—not the chronological diary below—is the convergence authority. The diary is retained
as an incident/history appendix and may contain stale historical descriptions that were true only
for their round.

- **Operator boundary (2026-08-26):** v1 uses an 80/20 threat model: trusted OS/operator/same-UID
  processes and one application writer. Crashes, torn writes, static corruption/oversize, symlinks,
  foreign restore, and declared recovery states are in scope. Active concurrent same-UID mutation
  is out of scope and would require a different transactional architecture.
- **Frozen terminal rule:** required external review first; then two full zero-DESIGN reviews by the
  frozen security/integration/decision lenses on one semantic body hash. Copy/status-only edits get
  one precision verification and do not reset DESIGN convergence. No new threat actor, capability,
  or test-tier interpretation may enter during the pair.
- **Testing interpretation:** exhaustive mechanism/fault matrix at unit; representative real public
  boundaries at integration; a small production lifecycle set at E2E. Every capability appears at
  all three tiers, but every syscall branch need not be repeated at all three.
- **Current status:** process repair in progress; prior round numbers and “converged” labels below
  are historical, not a present certificate. Source implementation remains unstarted.

| Sequence | Stage | Input hashes (ledger / foundation) | Result | Fold | Counts toward pair |
|---|---|---|---|---|---|
| P0 | 80/20 boundary ratified | `c5ae41bb…` / `dc7dfb56…` | threat model and terminal rule frozen | boundary-only | no |
| P1 | required external current-body review | `c5ae41bb…` / `dc7dfb56…` | MINOR / MINOR; zero SERIOUS or architecture-reset verdicts | none; optional hardening suggestions deferred | prerequisite complete |
| P2 | terminal-pair attempt 1 | `c5ae41bb…` / `dc7dfb56…` | security 1/0, integration 1/2, decisions 0/1 | aligned E2E with representative-tier rule; closed static symlink semantics; API shorthand | no—named frozen invariant was violated |
| P3 | repaired candidate + required external review | `3497ea43…` / `efd19ab7…` | MINOR / MINOR; zero SERIOUS or architecture-reset verdicts | none; optional hardening suggestions deferred | prerequisite complete |
| P4 | terminal pair round 1 | `3497ea43…` / `efd19ab7…` | security 0/0, integration 0/0, decisions 0/0 | none | yes—1 of 2 |
| P5 | terminal pair round 2 | `3497ea43…` / `efd19ab7…` | security 0/0, integration 0/0, decisions 0/0 | none | yes—2 of 2 |

The P1 external MINOR suggestions (additional diagrams/naming/metrics guidance and alternate recovery
ergonomics) do not violate a frozen v1 invariant and are intentionally not folded into the semantic
body. P2 found the old exhaustive-E2E wording contradicted the newly frozen testing rule and that
static symlink scope needed one closed behavior; those limited repairs produced P3. External review
confirmed P3 without a serious or architecture-reset verdict; its terminal pair may now begin.

**Current verdict: CONVERGED under the operator-ratified 80/20 v1 contract.** P4 and P5 were two
independent, full, zero-DESIGN/zero-PRECISION reviews on identical semantic bodies. Required
external current-body review ran before the pair and returned MINOR only; its optional hardening
suggestions were intentionally deferred. The later structural move of three already-resolved
operator choices out of `Open questions` is metadata/organization only and does not change the
semantic body. Review is terminal: no post-convergence content round remains. Source implementation
may begin after the structural convergence tags and operator approval tags are present.

## Cross-model review: codex-cli:gpt-5.5

Real external passes ran through the agent's own CLI logins, including round 9. Round 1 and round 2
each received one GPT-tier pass (`codex-cli:gpt-5.5`, `crossFamily: true`) and one clean-door
Anthropic pass (`claude-code:claude-fable-5`, `crossFamily: false` — recorded separately as
`clean-door-anthropic-review`, never laundered into the cross-model flag). `gemini-cli` was
detected but not authed (`gemini-not-authed`); `grok-build` not enabled.

## ELI10 Overview

The operator runs four machines against eight subscription accounts, and logins keep falling out.
Clearing one costs about fifteen taps. He asked for three things, in order: record every sign-in
so the churn can be measured; build a guarded shared browser identity; then automate the sign-in
itself. This spec is the first of those — the measurement.

The reason measurement comes first is a real fork in the road. If logins are *expiring*, that is
a lifetime to automate around. If they are *disappearing*, something is removing them and that is
a bug — and a robot built to keep re-signing them in would hide it. Nothing in the system has
ever recorded a sign-in, so nobody could say which.

The ledger writes one line whenever a login starts, finishes, expires, is reissued, cancelled,
denied or fails, plus a line when an account *becomes* broken and when it *becomes* fixed. Then
one read turns those lines into rate, concentration, and cause. It watches and writes down; it
never blocks a sign-in, never triggers one, never touches a credential, and never messages anyone.

## Original vs Converged

**The biggest change: cause is now READ, not inferred.** The first draft proposed to answer
expiring-vs-disappearing by watching whether outages clustered at a fixed interval — a statistical
argument over weeks. Five reviewers independently rejected it, and the decisive objection was not
that the statistics were weak (they were) but that *the answer is already on disk at the moment of
detection and was being thrown away one line before it could be recorded*. An expired credential
and an absent one are distinguishable by looking. The spec now records an evidence class per
episode and the clustering heuristic is deleted outright.

**The instrument was wired to a producer that barely runs.** The first draft hung its rising edge
on a loop inside the credential-repair path. That path is gated to development agents and, even
there, executes only when a *new* quarantine occurs on the same pass. On three of the operator's
four machines it would have recorded nothing while reporting a confident zero — which reads as
"those machines are healthy". The ledger now sources its own census from an always-on tick.

**Nothing could ever close an episode.** Every reviewer that looked for the falling edge found no
producer for it. `medianHoursToResolve`, `unresolvedNow` and every interval depended on a
transition nothing observed. The census diff now produces both edges from one enumeration.

**"No episodes" was indistinguishable from "not watching".** Five separate conditions — server
down, machine asleep, kill-switch off, dev gate, quarantine gate — all produced an empty result
that rendered as health. Coverage is now a measured quantity with its own denominator, and an
unmeasured cell renders `null`, never `0`.

**The evidence floor was off by one.** The draft refused to state a rate below two episodes,
reasoning correctly that one observation is not an interval — and then two episodes yield exactly
one interval, so the floor permitted precisely the thing it forbade. Floors are now per statistic:
three episodes for a mean interval, two *resolved* episodes for a median, and the flag moved onto
each row because one boolean cannot qualify an eight-row table.

**Retention was described as something the code does not do.** The chosen component rotates whole
files and deletes the oldest archive; it does not trim, and has no row-count bound. The draft's
stated budget was wrong on all three counts, and the failure it hid is specific: rotation evicts
the oldest rows, which are disproportionately episode *openings*, so the measured rate falls as
volume rises. **Round 2 shows this is still not resolved** — see below.

**A live finding changed the grounding.** While reviewers were reading, the two accounts the spec
cited as its motivating evidence turned out not to be missing a login at all: they were the only
two whose Google account also backs a Codex subscription, and an unscoped email lookup rendered
that ambiguity as `missing-local-login`. Fixed separately. The lesson the spec absorbed is larger
than the bug — a `relogin-required` flag did not mean a login was missing, so the instrument must
record *why* it believes a cell is broken.

## Iteration Summary

| Round | DESIGN | PRECISION | Conformance gate | External verdicts |
|---|---|---|---|---|
| 1 | 49 | 6 | ran (2 flags) | codex MINOR · clean-door MINOR |
| 2 | ~55 | ~12 | ran (0 flags) | codex **SERIOUS** · clean-door MINOR |
| 3 | ~30 | ~10 | pending | codex MINOR · clean-door MINOR |
| 4 | 13 | 3 | ran (1 flag) | codex MINOR · clean-door MINOR |
| 5 | 8 | 5 | ran (1 flag: the pending ratification) | codex MINOR · clean-door MINOR |
| 6 | 11 | 5 | — | codex SERIOUS* · clean-door unavailable† |
| 7 | ~10 | ~8 | — | codex MINOR ×2† |
| 8 | 3+3 | 4+2 | — | codex MINOR |
| 9 | 8 unique after dedupe | 4 unique after dedupe | ran (0 flags) | codex MINOR |
| 10 | 7 unique after dedupe | 3 unique after dedupe | ran (1 framework-scope flag) | degraded: timeout |
| 11 | 6 unique after dedupe | 5 unique after dedupe | ran (0 flags) | codex MINOR |
| 12 | 4 unique after dedupe | 3 unique after dedupe | ran (0 flags) | codex MINOR |
| 13 | 5 unique after dedupe | 3 unique after dedupe | ran (0 flags) | codex MINOR |
| 14 | 2 unique after dedupe | 3 unique after dedupe | ran (0 flags) | codex MINOR |
| 15 | 3 unique after dedupe | 1 unique after dedupe | ran (0 flags) | codex MINOR |
| 16 | 1 unique after dedupe | 0 | ran (0 flags) | codex MINOR |
| 17 | 1 unique after dedupe | 0 | ran (0 flags) | codex MINOR |
| 18 | 2 unique after dedupe | 0 | ran (0 flags) | codex MINOR |
| 19 | 4 unique after dedupe | 2 unique after dedupe | ran (0 flags) | codex MINOR |
| 20 | 1 unique after dedupe | 2 unique after dedupe | ran (0 flags) | codex pending |
| 21 | 3 unique after dedupe | 1 unique after dedupe | ran (0 flags) | codex pending |
| 22 | 2 unique after dedupe | 2 unique after dedupe | pending | pending |
| 23 | 2 unique after dedupe | 1 unique after dedupe | pending | pending |
| 24 | 3 unique after dedupe | 0 | ran (0 flags) | codex pending |
| 25 | 1 unique after dedupe | 0 | ran (0 flags) | codex pending |
| 26 | 4 unique after dedupe | 0 | ran (0 flags) | codex pending |
| 27 | 2 unique after dedupe | 0 | pending | pending |
| 28 | 2 unique after dedupe | 0 | pending | pending |
| 29 | 2 unique after dedupe | 2 unique after dedupe | ran (0 flags) | codex pending |
| 30 | 3 unique after dedupe | 1 unique after dedupe | ran (0 flags) | codex pending |
| 31 | 2 unique after dedupe | 1 unique after dedupe | ran (0 flags) | codex pending |
| 32 | 3 unique after dedupe | 1 unique after dedupe | ran (0 flags) | codex pending |
| 33 | 2 unique after dedupe | 1 unique after dedupe | ran (0 flags) | codex pending |
| 34 | 2 unique after dedupe | 0 | ran (0 flags) | codex pending |
| 35 | 2 unique after dedupe | 2 unique after dedupe | ran (0 flags) | codex pending |
| 36 | 2 unique after dedupe | 1 unique after dedupe | ran (0 flags) | codex pending |
| 37 | 2 unique after dedupe | 1 unique after dedupe | pending | pending |
| 38 | 1 unique after dedupe | 1 unique after dedupe | pending | pending |
| 39 | 0 | 0 | unavailable after checkout replacement | deferred during checkout recovery |
| 40 | 0 | 0 | unavailable after checkout replacement | codex MINOR (current body) |
| 41 | 0 | 1 unique | unavailable after checkout replacement | codex MINOR |
| 42 | 1 unique | 0 | unavailable after checkout replacement | pending |

Body hashes: round 1 `44480b05…`, round 2 `498ac91b…`, round 3 `91182d51…`. The body changed each
round, so no external pass was delta-skipped.

Round 2 found MORE than round 1, and the honest reason is that the round-2 rewrite introduced new
defects — a heartbeat that broke its own storage budget by 30–85×, a `mode` option on a class that
has none, an evidence enum with three producerless values, and a path by which credential bytes
could reach a permanent log. A rising finding count between rounds is not noise here; it is the
loop working on a document that had grown faster than it had improved.

Round 3 responded by cutting the spec from 542 lines to 324 rather than adding a fourth layer of
rules.

### Round 1 — the two conformance-gate flags

- **Migration Parity** — the spec added a `generateClaudeMd()` section while claiming no migrator
  entry was needed. The gate was right. All four target machines are existing installs, so the
  feature would have reached zero of them. Resolved.
- **Expected Capacity Enforcement** — a bounded writer with no durable trim outcome. Resolved on
  paper in round 2, then found incoherent (below), and finally dissolved in round 3 by moving to a
  store whose retention is a `DELETE`.

Both cleared in round 2's gate run (0 findings, 90 standards checked).

## Round 2 — where the design actually broke

Seven reviewers. Five reached the same conclusion independently, and it is the finding that
reshaped the spec:

**The instrument was reading a symbol that is never written on most of the fleet.** Rounds 1 and 2
both sourced the rising edge from `identityDrift.repairState`. Those literals are written in
exactly one place, reachable only when a development-agent gate passes *and* a new quarantine
occurred on that pass. On three of the operator's four machines the field is never populated — so
the ledger would emit a full observation record and zero episodes, which reads as the healthiest
cell in the pool. Round 2 had answered round 1's version of this by changing *who enumerates*,
which is a non-sequitur: the gate is in the writer, one layer below. One reviewer named it as this
author's own recorded failure pattern — treating an edit as an outcome — reproduced inside the
instrument built to prevent it.

Four further findings that changed what would be built:

- **The coverage heartbeat broke its own arithmetic.** One row per 30s tick is 2,880/day — 98.8%
  of all rows, and ~30–85× the growth model the same section derived. The stated "active file
  rotates in ~14 months" was really ~5 days, so the multi-month rate the ledger exists to produce
  was unobtainable inside its own retention window. Worse, it was emitted *regardless*, so it
  credited full coverage to a cycle in which every probe timed out.
- **Two incompatible retention mechanisms.** The section correctly established that the chosen
  writer rotates whole files and cannot trim, then mandated "trim by whole closed episodes, never
  evict an open episode's row" — which that writer structurally cannot honour. Both externals found
  this independently.
- **A `mode: 0o600` option that does not exist**, on the class named, with three cited precedents
  that all use a different mechanism. The at-rest argument for an irreversible PII decision rested
  on it.
- **`email` crossing the mesh.** Three reviewers traced the `?scope=pool` fan-out this spec adopts:
  it fetches each peer's *plain* endpoint, which by the spec's own contract serves email. So the
  field transited regardless of what the merger stripped, and the proposed test (asserting the
  merged response) would have passed while the guarantee failed.
- **A new security defect introduced in round 2.** The `credential-unparseable` evidence class
  requires distinguishing a parse failure from an absent blob, which is exactly where an
  implementer writes `catch (e) { reason = e.message }` — and V8's JSON.parse messages embed the
  leading input bytes, which for this blob begin `sk-ant-oat…`. A permanent, never-retracted log.

A live finding also landed mid-round and is worth more than the spec: **the two accounts the spec
cited as its motivating evidence were not missing a login.** They were the only two whose Google
account also backs a Codex subscription, and an unscoped email lookup rendered that ambiguity as
`missing-local-login`. Fixed separately (PR #1980). A reviewer then found a *second*, independent
mechanism of the same family — an expired access token classified as `unavailable`, cached six
hours — which is unfixed and tracked as CMT-169.

## Round 3 — the simplification

Three structural changes, each replacing a rule with a different shape rather than another rule:

1. **The credential probe is the primary signal**; the drift flag is demoted to enrichment. This is
   the only move that makes the instrument work on a machine where the flag-writer is off.
2. **It rides `QuotaPoller`'s existing per-account credential read** (15 min, constructed
   unconditionally) instead of a 30s tick that only exists inside a mesh-identity branch. No new
   timer, no second keychain access, and ~23,000 fewer `security` spawns per day than round 2.
3. **SQLite instead of JSONL.** Both externals raised this independently in round 2, and the
   justification round 2 gave — repo convention — did not survive contact with the repo, which has
   54 `better-sqlite3` consumers including two ledgers. The choice dissolves the retention
   contradiction, the rotation-truncation problem, the concurrent-writer gap, torn final lines, and
   the need to modify a shared class.

Plus one deletion worth naming: **email is no longer recorded at all.** Rounds 1–2 spent four
decisions defending it — at-rest honesty, a serve-deny fence, a mesh-egress guarantee, and a
default-off flag that would have shipped the stated purpose disabled on every target machine. The
account id is the join key the rollup actually uses. Removing the field removed all four problems.

### Round 3 verdicts (all seven reviewers)

Both externals **MINOR ISSUES** — the first round with that shape on both. The clean-door pass
explicitly confirmed both structural calls ("a gated writer can't source an ungated instrument";
SQLite "is the industry-standard answer here, not over-engineering") and noted the spec is free of
the LLM-as-authority pattern, singling out the hard sample-size floors over an arbiter as correct.

The internal reviewers then found that round 3's simplification carries real unbuilt assumptions.
The five that will reshape round 4:

- **The probe's five outcomes are mostly unproducible where the spec puts it.** The observation
  QuotaPoller's loop actually holds is a three-state token resolution with no `expiresAt` and no
  refresh-token visibility, and the store's read collapses "not found" and "timed out" in a bare
  catch. Producing the enum requires widening `OAuthRefresher` — a shared module with nine
  consumers — which the spec's own "No shared class is modified" claim forbids. The spec required
  the distinction and forbade the only edit that produces it.
- **A stronger, already-corroborated signal was overlooked on the same code path.** A revoked
  refresh token is invisible to a blob probe (the refresher deliberately never drops a stored
  refresh token), so `present-access-lapsed` silently swallows the dominant real cause and forces
  the cause histogram toward "deleted". Meanwhile the SAME per-account pass already flips
  `status: 'active' ↔ 'needs-reauth'` off a real token exchange — machine-local, framework-covering,
  gate-free, edge-shaped, and corroborated by an actual API result. The adversarial reviewer's
  recommendation: make THAT transition the rising edge, with the typed `RefreshFailReason` as the
  cause class, and demote the blob probe to enrichment. Round 4 adopts this.
- **"The probe has no gate" is wrong.** `quotaPoller.start()` is guarded by a non-empty pool at
  boot; codex accounts route to a rollout-file reader and never touch the credential blob; disabled
  and unsupported-framework accounts are skipped. Each needs a coverage class or it renders as a
  permanent "cold start".
- **The posture table's `operator-ratified-exception` cites PR #1980, which is open, records no
  operator ratification, and doesn't establish what it is cited for.** The integration reviewer's
  conclusion: either obtain a real ratification, or concede `unified` is feasible (the merge rule
  already shows it) — and separately, the chosen `?scope=pool` fan-out precedent silently DROPS a
  machine with no rope URL, where the `/guards` precedent emits a named failure row.
- **SQLite relocates rather than dissolves two claims.** better-sqlite3 has no mode-at-open (the
  chmod must precede the WAL pragma or the -wal/-shm sidecars stay 0644 — measured live, and two
  in-tree precedents have the unsafe ordering); and the new `coverage` table has no retention rule,
  recreating the unbounded-growth finding in the table added to fix it. Adoption also requires the
  repo's `NativeModuleHealer` (1,254 field reports of NODE_MODULE_VERSION breakage) on an
  always-on boot path, which the spec did not mention.

### Round 3 — the finding that ended the design churn

The adversarial reviewer, reading the same `QuotaPoller` pass the round-3 spec chose to ride,
found that it **already adjudicates login death properly**: on a 401 it attempts a refresh-token
exchange and one retry before declaring `needs-reauth`, with a typed reason at every callsite, and
the transient cases (funnel contention, network blips) deliberately never flag. Rounds 1–3 had
each built a way to *infer* what this transition already *proves* — from a dev-gated flag, a
census of that flag, and a blob probe whose five outcomes were mostly unproducible at the chosen
read (verified: the token resolver returns three states, never reads `expiresAt` or the refresh
token, and the store's read collapses "not found" and "timed out" in a bare catch). A revoked
refresh token is additionally invisible to any blob inspection, because the refresher deliberately
never deletes one — so round 3's cause histogram would have been structurally forced toward
"deleted".

The lessons/decision-completeness reviewer added the round's other structural results: the
`operator-ratified-exception` posture key cited an unmerged PR that records no operator
ratification — candour about riding the hatch is not ratification, and the decision was moved to
an explicit operator question; the three-part `attemptId` (round 3's two-part key silently
collapsed N reissue-expiries into one, because `reissue()` never touches `createdAt`); the CMT-169
chain split into its two real mechanisms (a repair-plan **raise** and a 6h-cache **hold**); and
four of eight `(reversible)` tags rejected — the honest count is that most of this feature's
decisions are durable row semantics on a published route.

## Round 4 — recording the verdict instead of inferring it

One structural change: the ledger records the `active ↔ needs-reauth` transitions and the typed
reason already passed at each `markNeedsReauth` callsite. The blob probe, the five-value enum, and
the shared-module edit are deleted. Everything else is the round-3 findings folded: chmod before
the WAL pragma (sidecars), `NativeModuleHealer` on the open, `listPoolMachines`-style fan-out with
named failure rows, `os.hostname()` as the lazy durable cell key, coverage from per-account
observation outcomes with `unmeasured-store-unavailable` sourced from an out-of-DB watermark,
timestamps-not-counts for `observedHours`, gap-aware duration bounds, a P20 instrumentation table
that actually exists, per-deferral carrier refs, and a Rollback section that deletes the DB and
its sidecars as a set.

Round 4's conformance gate: **1 flag** — the codex-coverage gap (two of the operator's eight
accounts are codex-cli, whose poll path reads a rollout file and never the credential, so their
cells can only render `skipped-no-credential-read`). Stated in Honest scope; the round-4 reviewers
were explicitly asked to judge whether stating it is enough.

### Round 4 — the deepest finding of the loop, and the fold

Both round-4 externals endorsed the core signal ("well grounded and avoids the earlier
symbol-authority trap"; "riding the exchange-corroborated transition instead of blob-probing is
right"). The combined internal review then found the loop's single sharpest defect, R4-1: **as
designed, a DELETED credential produced no transition at all.** The token resolver receives a
typed three-way reason from the credential read and throws the "absent" members away — the account
is silently skipped, no status change, no edge. Round 4's instrument measured REVOCATION and was
blind to DISAPPEARANCE, the operator's actual complaint; every cause histogram would have been
biased toward "expiring" — the inverse of round 3's bias, and equally wrong. The fix is confined
to `QuotaPoller.ts` (widen the resolution's reauth union with the reasons the read already
computes), so the no-shared-module promise holds.

The same review established: the falling edge could close an episode on a DIFFERENT account than
opened it under identity drift (edges now keyed on the attributed id, derived from a settled
re-read of the field, with the open-episode row as the durable prior status); the round-4 callback
placement could not produce half its own payload (now an explicit two-fire contract); the
`NEVER_SERVED` deny entry was written in the legacy root form that the file's own comment says
never matches production (now dual-root, with the test asserting the production form); the
watermark file was load-bearing but unspecified as an artifact (now: path, mode, schema, both deny
lists, posture row, rollback set); `os.hostname()` as a durable key both splits (documented
in-tree flap incident) and silently merges (default hostnames) — replaced by a persisted stable
machine id with hostname as a marked fallback; and the codex blindness was judged MATERIAL rather
than disclosable — 25% of the fleet as a constant coverage value cannot distinguish healthy from
unlooked-at — resolved with a demand-proxy freshness split and a second operator question for a
true auth signal.

## Round 5 — all sixteen round-4 findings folded

One conformance flag remains and it is the pending operator ratification itself — the mechanism
holding the spec open on the one decision that belongs to the operator. Round-5 reviews running.

### Round 5 — the authority catch

Both externals MINOR again, now endorsing specifics ("level-triggered alerting done right",
"genuinely good survival-analysis hygiene"). The combined internal review then caught the round's
one serious defect, R5-1: **the round-5 fix for the deleted-credential blindness would have turned
the observability spec into a gating change.** Widening the token resolution so absence flags
`needs-reauth` routes through a status that gates capacity, swap-target eligibility, rebalancer
participation and the operator repair prompt — and the store's read collapses a 3-second keychain
timeout into the same null as genuine absence, so a transient `securityd` contention would have
flipped a healthy login's availability and manufactured the exact false-flag class the ledger
measures (CMT-169's shape). It would also have broken the post-enrollment re-verify's stated
invariant, opening an episode at the timestamp of a successful sign-in.

Round 6 decouples: the widened absence reasons ride the ledger's observation payload only; pool
status stays on the exchange-corroborated paths. The disappearance blindness stays fixed — as an
observation, which is what this spec claims to be.

Round 5 also surfaced a LIVE QuotaPoller bug as a by-product (the needs-reauth restore predicate
reads the enumerated record while the patch lands on the attributed id — under identity drift a
recovered account is never restored, or the wrong row is restored), now tracked as CMT-171. That
makes three real production defects found by this spec's review process before a line of the
feature was built: the dual-subscription false missing-login (PR #1980, merged), the
expired-token raise-and-hold (CMT-169), and the restore attribution (CMT-171).

## Round 6 — decoupling folded, plus the round-5 precision set

`refresh-read-failed` added to the cause table (it was reachable and unmapped); the two-fire
contract made exactly-once by a guard token with the direct `pollAccount` caller named; codex
freshness thresholds numeric (6h) plus the undated case; decimation-aware delta caps so long
windows are not structurally nulled; watermark mint reconciles against the store (adopt-or-mark)
so a lost watermark cannot orphan history; `signalKind: auth | demand-proxy` typed onto coverage
rows; the posture rows now carry `physical-credential-locality` on their face, narrowing the
operator question to read-vs-replicate; one unified peer-failure enum; `label` clamped.

Mid-round, the agent-home checkout was reset by the release auto-update (v1.3.1203 — the release
carrying PR #1980); the spec files survived, the round-6 fold was re-applied, and backups now sit
outside the repo.

### Round 6 — a corruption artifact, a coupling catch, and the close path

\* Codex's round-6 SERIOUS was partly an artifact of the checkout-reset corruption (verbatim
duplicated enum rows from a re-applied fold against a rolled-back baseline — real, mine, and
fixed), but its substantive findings were genuine: a multi-pass confirmation floor before a
read-only absence observation may open an episode; closed denominator membership for
`observedHours`; an exact locking model; and a normative schema block whose partial unique index
is the exactly-once open guard. † The clean-door family went unavailable when the update changed
config resolution; restored via an explicit `INSTAR_CONFIG_PATH`.

The internal round-6 review then caught three things that mattered:

- **The named code edit contradicted the decoupling prose.** "Widen the `TokenResolution` REAUTH
  union" routes absence straight into the single writer of `needs-reauth` — the exact coupling
  the same section forbids. Round 7 renames the arm (`observationOnly`) so the type shape itself
  prevents the coupling, with a wiring test that absence leaves status `active`.
- **`unparseable-credential-blob` already gates today.** Decoupling it would have silently
  REMOVED a live operator repair prompt and capacity exclusion — a loosening gating change in an
  "observability only" spec. It keeps its existing status write, carved out explicitly.
- **The absence episode had no close path** — the falling edge is a status transition an absence
  cell never makes, so every read-only episode stayed open forever, permanently censoring the
  cell. Round 7 adds the full episode lifecycle: a closed settled-fire outcome enum,
  `resolved-clean` as the read-only close, its own duration bucket, the 3-pass open floor, and
  upgrade-in-place with `escalatedAt`/`preEscalationHours` so a blip followed by a real
  revocation cannot publish the revocation under an absence cause.

Plus a units bug in my own pseudocode (milliseconds vs minutes — the decimation fix as written
reproduced the exact 50% integration it existed to prevent), the watermark schema missing the
fields its own reconciliation paragraph requires, and assorted precision.

### Round 7 — the floor that wasn't, and the ledger of small truths

† Both round-7 external slots were served by codex (the clean-door invocation fell back after the
update changed config resolution); noted rather than counted as two families.

The round-7 internal review's one high finding was exact: the spec claimed its 3-consecutive-pass
absence floor spanned "≥30 minutes at the default cadence" — but a pass is any `pollAll`
invocation, and `ProactiveSwapMonitor` polls every 180 seconds whenever any account sits in its
watch zone (≥65% utilization — routine), so three passes can span six minutes, inside a
`securityd` contention burst. The floor became conjunctive: count AND wall clock. The same round
caught the decisions ledger still instructing the forbidden edit ("widen the reauth union") that
the design section had renamed away, an `escalatedAt` the schema could not persist, three
persisted columns with no closed domain, an existing unit test the type change breaks (which
darwin-skips, so it would only have gone red in CI), and a retention rule with no trigger.

### Round 8 — findings appeared to stop changing the build

All round-7 items folded, plus the externals': an explicit absence-accumulator state machine, a
mixed-signal priority table, LATER-row delta-cap semantics, `boundaryUncreditedHours`,
cross-process `readonly: true` enforcement, and the honest acknowledgment that this design IS a
small SQLite event store with a materialized episodes view.

Round-8 codex verdict: MINOR, "no serious architectural objection". Its items — a top-level
`statusEpisodes`/`readOnlyEpisodes` response split, watermark ownership fields with a PID-reuse
rule, the floor reframed as a tunable default with a stated false-positive budget, property tests
for the coverage math — were folded the same hour. Each changed the build by a field or a test,
not a mechanism.

## The stopping question

The skill's formal criterion is two consecutive rounds with zero DESIGN-class findings, and no
round has been fully quiet. The operator's ratified convergence standard (2026-08-19) is
different: **"stop spec review when findings stop changing the build, not after N clean
rounds."** Rounds 1–6 each changed the build structurally (the signal source three times, the
storage engine, the authority boundary, the episode lifecycle). Round 7 changed floors and
schema columns. Round 8 changed a response shape and three watermark fields. The trajectory is
the 80/20 curve the operator's standard describes.

The round-8 internal result arrived at the predicted scale: three DESIGN findings, every one a
seam between two prior folds (an upgraded episode routed by two disagreeing fields; a decision
clause contradicted by a later fold's placement rule; two enum members with no producer —
deleted under the spec's own rule), and four precision items. All folded within the hour; none
changed a mechanism.

The operator chose the 80/20 stop and resolved all three decisions. Before source work, however,
the instar-dev structural gate correctly refused a spec with no formal convergence tag. Round 9
therefore resumed review instead of forging the tag. It found material carrier and bound gaps:
the absence accumulator existed only in prose; the watermark omitted operational fields; a
10-minute writer lease conflicted with the guaranteed 15-minute cadence; retention did not bound
coverage or standalone events; and unthrottled manual polls defeated the volume model. Those are
build-changing DESIGN findings, so the earlier stop recommendation is withdrawn on evidence.

## Convergence verdict

**Not converged after round 9.** All operator decisions are resolved, but round 9 produced new
DESIGN-class findings and therefore cannot be the first quiet round. The findings are folded;
the next review must evaluate the revised design. Source implementation remains gated.

### Round 10 — bounds and foundation checks

Round 10 verified the accumulator, watermark, quarantine, machine identity, migration, and
writer-lease corrections. It then found the 50k coverage cap could not retain its promised
resolution at 64 cells; event producers were not included in the drain proof; PendingLoginStore's
swallowing `save()` could not prove a post-commit callback; the second-instance override could
bypass writer exclusivity; and the new capacity state outran the read contract. These findings
changed mechanisms and carriers, so formal convergence remains blocked. The external Codex pass
was attempted but timed out after the conformance gate; recorded as degraded, not a clean pass.

**Current verdict: not converged after round 10.** The findings are folded into the current
draft. Source implementation remains gated pending a later clean pair.

### Round 11 — conflict semantics and restored-state authority

Round 11 verified the round-10 corrections and found fewer but still build-changing gaps:
coverage bucket conflicts had no winner; lifecycle uniqueness would erase a later successful
code submission; restored foreign DB rows could defeat the coordinator identity that rejected
their watermark; admitted-cell membership was not durable; and failed pending-login saves could
leak into a later successful write through mutated memory. The spec now defines a reducer,
evidence lattice, event keys, copy-on-write persistence, coordinator-only identity authority, and
a persisted admitted-cell set. The cross-model reviewer returned MINOR issues; conformance ran
with zero flags.

**Current verdict: not converged after round 11.** DESIGN findings remain nonzero, so this round
does not start the required quiet pair.

### Round 12 — bounded reads and evidence-preserving coalescence

Round 12 verified the round-11 mechanisms and found four build-changing seams: configurable poll
cadence invalidated the fixed retention proof; coverage UPSERT moved a winning class to a losing
observation's timestamp; raw pool-wide reads were unbounded; and clamped free text could still
store the very secrets the spec promised never to write. The revision fixes ledger buckets at
15 minutes, retains winning evidence time separately from last observation time, bounds raw and
peer reads before materialization, and deletes free-text lifecycle payloads entirely. It also
closes skipped-cell episode semantics and makes observer usage an API invariant. Conformance ran
with zero flags; the Codex external returned MINOR issues.

**Current verdict: not converged after round 12.** DESIGN findings remain nonzero; round 13 must
evaluate the revised contract.

### Round 13 — composition bounds and retained idempotency

Round 13 verified round 12 and found composition gaps: fixed 15-minute writes disagreed with
configurable-cadence coverage arithmetic; lifecycle dedupe vanished when its event row aged out;
pool fan-out had no whole-request bound; and row-wise foreign quarantine could ingest a maximum
foreign store. The revision fixes coverage integration to the ledger bucket, adds bounded
event-key tombstones, caps pool work end-to-end, and quarantines foreign DB files as a unit before
queries. It also makes submit events explicitly request-attempt telemetry, binds seek cursors,
and states admission uses enumerated pool ids only. Conformance ran with zero flags; Codex
external returned MINOR issues.

**Current verdict: not converged after round 13.** DESIGN findings remain nonzero; round 14 must
evaluate the revised contract.

### Round 14 — crash-safe quarantine and reserved dedupe capacity

Round 14 verified round 13 and found two DESIGN gaps: tombstone capacity had no saturation
outcome, and three SQLite files cannot be atomically renamed as a unit. The revision reserves
tombstone capacity when keyed events enter, and moves the complete store into a dedicated
directory governed by an fsynced intent + one atomic directory rename with restart recovery.
Pool pages now disclose partialness and withhold fleet aggregates; processed submit attempts are
defined precisely. Conformance ran with zero flags; Codex external returned MINOR issues.

**Current verdict: not converged after round 14.** DESIGN findings remain nonzero; round 15 must
evaluate the revised contract.

### Round 15 — directory semantics and cadence-aware liveness

Round 15 had one fully clean reviewer, but the other lenses found three operational DESIGN gaps:
directories were incorrectly assigned file mode 0600; a prior-quarantine deletion failure could
accumulate foreign stores; and store liveness still assumed the default cadence. The revision
uses 0700 directories/0600 files, reclaims the single quarantine slot through SafeFsExecutor
before rename, and records a bounded guaranteed cadence for liveness. It adds explicit capacity
invariants and a reducer input/output table. Conformance ran with zero flags; Codex external
returned MINOR issues.

**Current verdict: not converged after round 15.** Because any DESIGN finding resets the pair,
the one clean lens does not start formal convergence. Round 16 must evaluate the revision.

### Round 16 — observed absence is still observed time

Round 16 had a clean integration review and verified every round-15 fix. One DESIGN finding
remained across the other lenses: a successfully executed resolver returning “absent” had been
given a distinct coverage class that the denominator excluded, turning adverse evidence into a
monitoring gap. The revision keeps coverage `measured`, carries health separately as
`authResult`, reports healthy and absence-observed hours independently, and separates read-only
`observationClass` from status `causeClass` in storage. It also nulls aggregates across capacity
refusals and closes clock-suspect reducer semantics. Conformance ran with zero flags; Codex
external returned MINOR issues.

**Current verdict: not converged after round 16.** One DESIGN finding means the quiet-pair count
remains zero. Round 17 must evaluate the revision.

### Round 17 — refusal history needs time

Round 17 had one fully clean reviewer and verified the round-16 observation semantics. One
DESIGN gap remained: cumulative watermark counters could not tell whether a capacity refusal
intersected a requested summary window, so the promised null aggregate was not implementable.
The revision adds a bounded hourly typed refusal ledger outside the capped event table and pins
the complete adverse-observation/refusal boundary test matrix. Conformance ran with zero flags;
Codex external returned MINOR issues.

**Current verdict: not converged after round 17.** The quiet-pair count remains zero; round 18
must evaluate the revision.

### Round 18 — a failed database cannot testify about itself

All three reviewers verified the round-17 window-boundary repair, then found two related DESIGN
gaps. The claimed 180-day `write_refusals` retention had neither a pruning trigger nor a deletion
budget, so its hourly primary key bounded density but not lifetime. More fundamentally, SQLite
`busy`, I/O, or unavailable-store failures cannot durably increment a table inside the transaction
that just failed. The revision gives transactional refusals a strict pre-UPSERT cap plus bounded
hourly pruning, moves store-layer failures to an independently atomic bounded sidecar, and makes
failure of both carriers explicitly evidence-incomplete rather than silently measurable. It also
states physical tombstone expiry cleanup and tests long-offline catch-up and every failure point.

**Current verdict: not converged after round 18.** Two DESIGN findings reset the quiet-pair count
to zero. Round 19 must evaluate the revised carrier and retention contracts.

### Round 19 — uncertainty must survive a polite restart

Round 19 verified the carrier split and bounded pruning, then found that an in-memory
evidence-incomplete latch could disappear across a graceful stop if both durable carriers were
still failing. It also found the sibling sidecar missing from rollback/file-route protection, no
defined floor for empty carriers, no frontloaded durable/public decision for the new refusal
contract, and insufficient production-lifecycle E2E coverage. The revision withholds the clean
stop marker until a pending latch is durable, gives both carriers explicit empty floors, adds the
sidecar and temp siblings to every lifecycle boundary, records Decision 16, and drives the entire
cross-carrier path through production initialization and restart.

**Current verdict: not converged after round 19.** DESIGN findings keep the quiet-pair count at
zero. Round 20 must evaluate the fail-closed lifecycle and full refusal-subsystem boundary.

### Round 20 — a blind interval needs an end

The integration lens was fully clean and decision completeness found no remaining operator choice.
Security found one DESIGN gap: a durable `evidenceIncompleteSince` had no close boundary, so
clearing it erased history while retaining it poisoned every future window. The revision closes a
recovered latch into bounded, deduplicated hourly incomplete buckets. Precision repairs add the
observer-invariant classes to the persisted coverage enum and name the sibling sidecar separately
in multi-machine posture.

**Current verdict: not converged after round 20.** The DESIGN finding resets the quiet-pair count
to zero. Round 21 must evaluate bounded closed-gap semantics.

### Round 21 — validate before committing; invalidate by field

Round 21 verified closed-gap persistence but found that duplicate-settle detection at `finish()`
was too late if the first settle had already committed an edge. It also found ambiguous aggregate
nulling across blind intervals and missing tests for the newly claimed health diagnostic. The
revision buffers all settled outcomes and commits only after finish-time cardinality validation,
defines a closed per-field invalidation matrix for every refusal/gap/floor class, persists separate
event and coverage floors, and adds integration plus production-wiring health tests.

**Current verdict: not converged after round 21.** DESIGN findings keep the quiet-pair count at
zero. Round 22 must evaluate finish-time commit and invalidation semantics.

### Round 22 — direct calls need a registered target

Round 22 verified finish-time buffering and the aggregate invalidation matrix, then found that the
direct reverify path intentionally has no enumerated fire while `finish()` validated only
enumerated cells. It also found the matrix conflated recovered historical store failures with an
actively unreadable store. The revision adds an explicit one-target direct observer mode, tests its
zero/one/double cardinality through the real callsite, preserves all five health states, and gives
active `store-unavailable` its own raw-unavailable/null-aggregate contract locally and in pool
fan-out.

**Current verdict: not converged after round 22.** DESIGN findings keep the quiet-pair count at
zero. Round 23 must evaluate the direct-mode and active-store-failure contracts.

### Round 23 — one lifecycle owner and an unavoidable finish

Round 23 verified active-store semantics and direct target registration, then found split ownership
between routes and QuotaPoller plus no structural guarantee that buffered observations reach
`finish()` after throws or cancellation. The revision makes `pollAccountDirect` the sole direct
lifecycle owner, keeps routes observer-blind, runs idempotent finish from `try/finally` in both
normal and direct modes, and turns unfinished expected cells into a closed aborted coverage class.
It also distinguishes logical skipped completion from the finish-time physical commit.

**Current verdict: not converged after round 23.** DESIGN findings keep the quiet-pair count at
zero. Round 24 must evaluate lifecycle ownership and unavoidable finish semantics.

### Round 24 — pre-register the census; never throw from observation

Round 24 verified singular ownership and unavoidable finish, then found that lazy cell registration
left an unvisited suffix invisible after mid-pass failure. It also found that a throw from the
`finally`-owned ledger finish could mask the poller's authoritative return/error, and that real
production cancellation/timeout paths needed stronger coverage. The revision pre-registers the
entire pool census before processing, makes finish externally non-throwing while preserving the
original outcome byte-for-byte, and drives each failure path through integration plus production
initialization.

**Current verdict: not converged after round 24.** DESIGN findings keep the quiet-pair count at
zero. Round 25 must evaluate full-census abort and non-interference semantics.

### Round 25 — the census is the admitted set, not arbitrary config

Two lenses were fully clean and verified non-interference. Security found that pre-registering every
`pool.list()` entry bypassed the durable 64-cell ceiling and allowed corrupted configuration to
expand observer memory, writes, and response identifiers without bound. The revision performs
admission first, registers only the persisted admitted census, keeps overflow out of coverage, and
reports it through a bounded count plus 64-id cursor pages.

**Current verdict: not converged after round 25.** One DESIGN finding keeps the quiet-pair count at
zero. Round 26 must evaluate admission-first census bounds.

### Round 26 — admission eligibility and work must both be bounded

Round 26 verified the 64-cell observer/write bound, then found reconciliation itself could still
scan/sort arbitrary configuration, nested overflow pagination was underspecified, eligibility for
disabled/unsupported incumbents was unresolved, and the durable policy was not frontloaded. The
revision uses a 4,096-entry scan ceiling and fixed 64-entry heap, admits enabled supported cells
while preserving temporarily unresolved ones, replaces nested pagination with an honest bounded
count/sample, and records the non-reversible policy as Decision 17.

**Current verdict: not converged after round 26.** DESIGN findings keep the quiet-pair count at
zero. Round 27 must evaluate bounded admission and eligibility transitions.

### Round 27 — use the real account model and indexed incumbents

Round 27 verified the bounded count/sample response but found two foundation defects: eligibility
referenced a nonexistent `enabled` field, and a truncated candidate prefix could not distinguish a
reordered incumbent from a removed/disabled one. The revision exports one support predicate shared
with QuotaPoller, uses the real status carrier (`status !== 'disabled'`), and revalidates at most 64
incumbents through indexed `pool.get()` before the bounded candidate scan on every pass.

**Current verdict: not converged after round 27.** DESIGN findings keep the quiet-pair count at
zero. Round 28 must evaluate canonical eligibility and incumbent revalidation.

### Round 28 — an indexed claim requires an index

Round 28 verified eligibility semantics, then source inspection showed `SubscriptionPool.get()` is
an array find and `list()` clones the entire backing array. The claimed bounded lookup/scan did not
exist, and its source file was absent from scope. The revision adds a maintained id index and a
bounded scan API to SubscriptionPool, makes their atomic coherence and duplicate-id behavior
normative, adds the file to Changed files, and tests work performed inside the pool across all
three tiers.

**Current verdict: not converged after round 28.** DESIGN findings keep the quiet-pair count at
zero. Round 29 must evaluate the real index/bounded-scan foundation.

### Round 29 — preserve legacy visibility; never collapse invalid authority

Security was fully clean. Integration and decision review found that the new raw index/scan could
expose legacy blank-email repair rows that `list()`/`get()` intentionally hide, that one old
`pool.list()` path still defeated the bound, and that duplicate durable ids had no safe load
behavior. The revision preserves exact list visibility while counting backing entries, removes all
full-list iteration from the poll pass, and makes duplicate-id stores explicitly `pool-invalid`
without mutation or silent empty-pool substitution.

**Current verdict: not converged after round 29.** DESIGN findings keep the quiet-pair count at
zero. Round 30 must evaluate visibility parity and invalid-pool authority behavior.

### Round 30 — invalid authority is broader than duplicate ids

Round 30 verified visibility parity and bounded polling, then found that malformed/read-failed pool
stores could still collapse to empty, the shared pool's invalid-state method behavior was undefined,
and peer fan-out lacked `peer-pool-invalid`. The revision defines a closed load taxonomy, makes all
data/mutation methods throw one typed fail-closed error while diagnostics stay non-throwing, maps
that error at central route/job boundaries, requires restart after repair, and carries the scrubbed
invalid state through local health and peer fan-out.

**Current verdict: not converged after round 30.** DESIGN findings keep the quiet-pair count at
zero. Round 31 must evaluate the shared availability contract and peer mapping.

### Round 31 — bootstrap and pool I/O are distinct states

Round 31 verified fail-closed invalid authority, then found that refusing every non-ready mutation
made first enrollment impossible, pool-file I/O lacked a public state distinct from ledger-store
failure, and the accepted legacy row schema was undefined. The revision permits only validated
first creation from legitimate `unconfigured`, adds local/peer `pool-unavailable` with time-bounded
historical semantics, and validates only after existing migrations with blank-email repair rows
explicitly accepted.

**Current verdict: not converged after round 31.** DESIGN findings keep the quiet-pair count at
zero. Round 32 must evaluate bootstrap, legacy validation, and pool-unavailable semantics.

### Round 32 — bound startup and remember lost authority

Round 32 verified bootstrap and public unavailable states, then found unbounded startup parsing, a
non-durable pool-authority gap timestamp, raw-history suppression under pool-invalid, and ambiguity
between a fresh missing file and deletion after enrollment. The revision caps pre-read bytes and
stored rows, carries open/closed pool-authority gaps in the refusal sidecar, serves retained raw
ledger evidence under both authority failures, and adds a one-way initialized marker plus admitted
cell cross-check. Missing root version is now invalid; only existing row migrations run.

**Current verdict: not converged after round 32.** DESIGN findings keep the quiet-pair count at
zero. Round 33 must evaluate bounded startup, durable authority gaps, and lost-file detection.

### Round 33 — publish authority and witness as one directory

Round 33 verified startup caps and durable gap history, then found that a separate initialized
marker could not be crash-atomically coupled to first pool persistence and was missing artifact
lifecycle protection. The revision replaces the two-file publication with one staged, fsynced,
atomically renamed authority directory containing both store and one-way witness; legacy migration
uses the same state machine. File access, backup/restore, fault recovery, and rollback all treat the
directory as an indivisible authority bundle, eliminating the ledger startup cross-check.

**Current verdict: not converged after round 33.** DESIGN findings keep the quiet-pair count at
zero. Round 34 must evaluate atomic directory publication and artifact lifecycle.

### Round 34 — the loss witness must outlive the directory

Round 34 verified atomic directory publication, then found that an in-directory witness disappears
with the directory it is meant to prove existed, and generic backup conflicts with physical-locality
authority. The revision adds a parent-level machine-bound initializing/initialized witness with
fail-closed crash recovery, retains the atomic authority directory for store consistency, and
unconditionally excludes directory, witness, and staging forms from backup/restore and file access.

**Current verdict: not converged after round 34.** DESIGN findings keep the quiet-pair count at
zero. Round 35 must evaluate the external witness state machine and backup exclusion.

### Round 35 — bind recovery to operation, source, and machine

Round 35 verified the parent witness and backup exclusion, then found legacy migration
indistinguishable from first-create recovery, undefined machine-id mismatch/remint behavior, and
overclaimed cleanup success. The revision records operation kind, generation, legacy digest/size,
and identity origin; defines exhaustive resume/fail-closed precedence; and makes cleanup fsync
load-bearing.

**Current verdict: not converged after round 35.** DESIGN findings keep the quiet-pair count at
zero. Round 36 must evaluate operation-bound and machine-bound recovery.

### Round 36 — no implicit authority-changing recovery

Round 36 verified operation/source-bound recovery, then found that the proposed rebind was an
underspecified security-critical authority transition with no proof protocol, surface, or crash
state. V1 now exposes no rebind at all. The recorded identity origin remains authoritative (so a
hostname-bound install remains hostname-bound if a coordinator later appears); mismatch/remint
fails closed and exceptional recovery requires deliberate local teardown and normal re-enrollment.

**Current verdict: not converged after round 36.** One DESIGN finding keeps the quiet-pair count at
zero. Round 37 must evaluate the deliberately no-rebind identity policy.

### Round 37 — bind to persisted machine identity, never hostname

Security was clean, but integration showed hostname binding would brick a valid pool on ordinary
rename, while decision review showed destructive teardown was neither a safe protocol nor compatible
with the zero-setup constraint. The revision binds only to the existing persisted MachineIdentityManager
machine id, independent of coordinator enablement and hostname. V1 has no rebind/teardown surface;
identity mismatch is terminal within this feature and routes to existing identity or enrollment
recovery workflows without deleting ledger history.

**Current verdict: not converged after round 37.** DESIGN findings keep the quiet-pair count at
zero. Round 38 must evaluate stable-identity binding and terminal mismatch semantics.

### Round 38 — prove the real identity dependency is wired

Security was clean and decision review found no DESIGN issue. Integration found the identity
foundation tested only at E2E, and the concrete class was misnamed. The revision names
`MachineIdentityManager` precisely and requires unit state-machine cases, integration behavior and
recovery, plus production wiring equality with coordinator/registry identity.

**Current verdict: not converged after round 38.** One DESIGN testing-integrity finding keeps the
quiet-pair count at zero. Round 39 must evaluate identity wiring across all three tiers.

### Round 39 — first clean round

All three lenses returned zero DESIGN and zero PRECISION findings. The concrete identity carrier,
all-tier wiring tests, authority boundaries, Decision 17, and zero-setup posture were independently
verified. The constitutional gate was unavailable after the workspace replacement removed local
vault/script plumbing; earlier rounds repeatedly ran it with zero flags, and this degradation is
recorded rather than treated as a pass. External review was deferred during checkout recovery and
then ran successfully on the same body in round 40.

**Current verdict: one clean round after round 39.** Formal convergence requires one more complete
clean round on the unchanged body.

### Round 40 — formal two-clean-round convergence

All three lenses again returned zero DESIGN and zero PRECISION findings on unchanged body hash
`e0c1599227c8766d6efe51f83e03572f93179656725ecfba18a5291d8e1e38d5`. This is the second
consecutive complete clean round. The live constitutional gate remained unavailable only because
the checkout replacement removed local vault/script plumbing; many earlier rounds ran it with zero
flags. The current-body external Codex reviewer returned MINOR issues: clarify singleton coverage,
correlated absence, identity authorities, health semantics, and executable closed-domain fixtures.
Those precision items are folded without changing the converged mechanisms.

**Current verdict: formally converged after round 40.** Two consecutive complete rounds contained
zero DESIGN findings. Round 41 confirms the external precision fold before tag publication.

### Round 41 — external precision fold

All internal lenses remained at zero DESIGN; two found one precision ambiguity in correlated
absence scope. It is now derived only from distinct accounts on the same machine/bucket, with
explicit positive/negative tests and named per-machine pool rollup. The current-body external
review remained MINOR, asking for an operational retuning policy, explicit justification for the
SubscriptionPool prerequisite boundary, and source-of-truth enforcement for normative tables.
Those are folded as clarification and CI contracts, not new mechanisms.

**Current verdict: convergence remains valid; round 42 confirms the precision-only body changes.**

### Round 42 — keep retuning passive

Integration was clean and the machine-local correlation fold was fully precise. Security and
decision review found one DESIGN regression introduced by the external clarification: promising an
automatic conversational retuning report contradicted the explicit no-watcher/no-notice posture.
The revision makes eligibility read-surface metadata only, with an on-demand report and no outbound
trigger, persistence, or delivery mechanism.

**Current verdict: the round-42 DESIGN finding resets the quiet pair. Round 43 must evaluate the
passive retuning contract.**

### Round 43 — passive retuning tests, then external architecture reset

Security and decision review returned zero findings. Integration found one DESIGN gap: passive
retuning had no named unit, integration, or production-E2E proof. Those boundaries and the
no-side-effect assertion were added. A fresh external current-body review then returned SERIOUS,
not minor: the ledger embedded an unrelated SubscriptionPool authority migration; credential-read
absence was still modeled as an “episode”; `coverage.class='measured'` overstated what the row
proved; and the sidecar writer's ownership was asserted without a two-process proof.

The architecture has been reopened accordingly. Pool authority is extracted to
`subscription-pool-authority-foundation.md` as a hard prerequisite with its own convergence duty.
The ledger consumes only its typed availability and bounded scan interface. Credential absence now
uses a separate `credential_read_windows` projection; status incidents remain in `episodes`.
Coverage is renamed `auth-path-observed`, and the SingleInstanceLock capability explicitly gates
both database and sidecar with a two-process byte-level test.

**Current verdict: not converged.** The external SERIOUS verdict invalidated the earlier quiet
streak. The next full round reviews both current documents and starts a new quiet-pair count only
if all DESIGN counts are zero.

### Split round 1 — make the extracted architecture executable

Across the three lenses: security 2 DESIGN/1 PRECISION, integration 4/1, decisions 2/4. Deduped,
the load-bearing findings were an unenforceable prerequisite gate, optional rollback compatibility,
an incomplete product-state reducer, unbounded credential-read windows, and an insufficiently real
writer-ownership test. The fold added a versioned gate, required rollback work, a separate window
schema/API with 180d/20k bounds and three-tier tests, and real child-process DB+sidecar contention.

### Split round 2 — separate the projections all the way through

Security returned 1 DESIGN/1 PRECISION, integration 2/0, decisions 2/3. Review found that the new
window retention floor could still invalidate otherwise complete incident statistics; that static
implementation compatibility was conflated with dynamic pool health, hiding degraded history; and
that a shim shipped by the migrating release cannot protect rollback to the prior binary. The fold
now gives incident and window projections independent floors, keeps degraded history reachable
under compatible v1 code, and uses a two-release reader-first/migration-second protocol tested
against the real prior artifacts.

**Current verdict: not converged.** Both split rounds contained DESIGN findings; the quiet-pair
count remains zero.

### Clean attempt B — first clean round on the split pair

After all split-round findings and precision folds, all three independent lenses reviewed both
unchanged specs end to end and returned DESIGN 0 / PRECISION 0. Body hashes were ledger
`5e8b678e6a0872b429abafd9da0a310596c624683aed4b8968c99c1deb511c38` and foundation
`762190c782f82bc9bbfb8d07301ccf0896023004875151c5cd978757d3bd3938`.

### Clean attempt C — second consecutive zero-DESIGN round

All three lenses independently returned DESIGN 0 on the same unchanged hashes. Security and
decision review returned PRECISION 0; integration found one stale header phrase only (“round 9
findings being folded”). The two-consecutive-zero-DESIGN criterion was therefore achieved on the
unchanged technical bodies. Updating that provenance changed only metadata. The post-fold review
returned no technical finding; it required this report and both headers to record the same state.

Post-fold hashes: ledger
`28854ef47f588a933d19a25a278fb0cfddfb6d07dcf924d48fadd03cbce4b3eb`; foundation unchanged at
`762190c782f82bc9bbfb8d07301ccf0896023004875151c5cd978757d3bd3938`.

**Current verdict: internally converged as a two-spec prerequisite pair.** Two consecutive full
rounds contained zero DESIGN findings; the metadata-only fold is confirmed. External current-body
review and convergence-tag publication remain required before source implementation.

### External current-body review — MINOR verdict, technical folds reset convergence

Independent Codex review returned MINOR on both specs but identified two material precision
mechanisms: same-bucket clean/absence evidence was last-write-order-dependent, and subsequent pool
saves did not define an atomic transaction for the digest-bound accounts/generation pair. The fold
adds a commutative `mixed` coverage lattice with deterministic timestamp/interval joins and split
metrics, plus an intent/witness-driven whole-directory update protocol with an explicit commit point
and closed crash-recovery table. It also clarifies backing-prefix semantics, repair-only capacity,
operator repair, alternatives, and lifecycle examples.

The first internal review of those folds found missing all-tier tests and an undefined witness
advance order; those are now folded. Because these are technical body changes, the earlier clean
hashes do not confer convergence on the current pair.

**Current verdict: not converged on the external-fold bodies.** Headers are reset to DRAFT and a
new quiet-pair sequence is required before external re-review/tag publication.

### External-fold internal rounds 1–2 — close new semantic and crash boundaries

Round 1 found that `mixed` needed a commutative evidence-field join, subsequent saves needed a
closed external-witness commit/recovery protocol, and all new behaviors needed explicit unit,
integration, and production-E2E proof. Round 2 found the reachable crash between the two directory
renames and the absorbing/same-result branches of the mixed lattice. The current bodies add those
states, independent-rename fault tests, closed witness-schema enumeration, prefix/capacity repair
lifecycles, and deterministic joins for every auth-result pair.

Current post-fold hashes entering the next review: ledger
`cea0f66196f396aeb4e85925a241f7090aa7a0222011a6a4995e83052ed77fa9`; foundation
`e96a985e2dc8ac9bd810aaaef41cbc63c6fd4e6417c597a751817bf24035d60d`.

**Current verdict: not converged.** Round 2 contained DESIGN findings; quiet-pair count remains
zero until the current post-fold hashes receive full clean rounds.

### External-fold rounds 3–4 — candidate publication recovery

Round 3 closed the between-renames crash and full mixed-lattice joins, then found that a crash while
building a candidate before durable external intent could strand valid OLD authority. Round 4 found
the first candidate-intent approach still had a mkdir-before-marker gap and left normalization
ordering unclear. The protocol now writes the external updating witness BEFORE mkdir; that durable
witness derives the only deletable candidate name. It explicitly normalizes `baseGeneration` to
committed form before either rename, with faults at mkdir, partial writes, every fsync, normalization,
each rename, commit, and cleanup. No staging marker enters the active directory.

Current hashes entering the next review: ledger
`2b70d361af026c93bd0676245f2110158a525160e90370371d4270ea55f6e9f8`; foundation
`12658c3d8ff63d531c56135901ad3ed50a03418d6c8241a842d273a1a9aba3a4`.

**Current verdict: not converged.** Round 4 contained DESIGN findings; quiet-pair count is zero.

### External-fold rounds 5–6 — post-commit cleanup semantics

Round 5 found that failure after the witness commit had an ambiguous caller result: NEW was durable,
but throwing from rollback cleanup could invite the caller to replay an already-committed mutation.
The fold publishes NEW in memory at commit and returns the discriminated
`{committed:true,cleanupPending:true}` result while keeping reads ready and blocking later writes.

Round 6 found that the phrase “explicit retry” named no actual API and conflicted with the stated
startup-only repair posture. The contract now has one path: transport retries and later mutations
receive a closed typed 409 before side effects, carrying `priorCommitMayHaveSucceeded:true`; callers
must re-read, and restart alone validates and removes the exact recognized rollback. Availability is
now a closed shape whose nullable maintenance field is orthogonal to `ready`, including peer and
HTTP mappings. Unit, integration, and production-E2E tests cover original result, readback,
transport retry refusal, next-write refusal, restart cleanup, and repeated-restart idempotency.

Round-6 counts before this fold were security 0 DESIGN/2 PRECISION, integration 1/0, and decisions
1/2. Current post-fold hashes entering the next full review are ledger
`2b70d361af026c93bd0676245f2110158a525160e90370371d4270ea55f6e9f8` and foundation
`0dba75f2ba2e5b4888c3c3c7e50513cee90dcfaef746b00b78941ee9a42303ce`.

**Current verdict: not converged.** Round 6 contained a DESIGN finding; the quiet-pair count remains
zero until the current unchanged bodies receive full clean rounds.

### External-fold round 7 — repeated cleanup failure and consumer parity

Security returned 0 DESIGN/3 PRECISION, integration 2/0, and decisions 0/1. The material gaps were
undefined behavior when restart cleanup fails repeatedly and missing proof across unified-peer and
non-HTTP mutation consumers. Startup now publishes validated committed NEW as ready/read-only on
each cleanup failure, retries the exact recognized rollback on every later restart, and leaves NEW,
memory, generation, and witness unchanged until deletion plus parent fsync succeeds. Local history,
pool peers, HTTP, scheduler, swap, follow-me, and enrollment now have explicit maintenance/refusal
semantics and all-tier coverage. The precision fold also carries ready-state maintenance through
the ledger history response.

Current post-fold hashes entering round 8 are ledger
`493944fab45cf18f15849cebc1ef3d28b948c3d1622e928a18436fb2fe882e90` and foundation
`e4808c7870c9dc956a906db55016207d46a283212fa1e25b3e71a7edc61045f2`.

**Current verdict: not converged.** Round 7 contained DESIGN findings; quiet-pair count remains zero.

### External-fold round 8 — durable deletion completion

Integration returned 0 DESIGN/0 PRECISION, decisions 0/1, and security 1/1. The missing state was
the normal committed steady state after cleanup—and specifically the case where rollback deletion
succeeds but parent fsync reports failure, then the next boot observes no rollback. The recovery
table now has a generation-neutral initialized-CURRENT/matching-active/no-sibling row that validates,
fsyncs the parent, publishes ready, and clears maintenance. Tests cover both possible observations
after the failed fsync: rollback reappears or remains absent. Ledger health now carries and tests the
same nullable maintenance field as its local and peer data responses.

Current post-fold hashes entering round 9 are ledger
`f6102293747a1d94cf01655aee88b3c6f7f912c8c3c6aef1897f170a627b4f97` and foundation
`e0e87c2d3725fb907f8e638cb51a97c2362cbb23b0a1177939397b83eb8f42ab`.

**Current verdict: not converged.** Round 8 contained a DESIGN finding; quiet-pair count remains zero.

### External-fold round 9 — persist cleanup durability intent

Security and integration each returned 0 DESIGN/0 PRECISION; decisions returned 1/0. The ordinary
clean boot and delete-succeeded/fsync-failed boot had identical artifacts, so a restart could not
know whether an absence-confirming fsync was required. The external witness now carries a closed
`cleanupPending` boolean: update commit sets it true before rollback deletion; only deletion/absence
confirmation, parent fsync, witness clear, and a second parent fsync make it false. Clean boots do
no cleanup fsync. Failed restarts retain the flag, preserving ready reads and closed mutations,
until the exact cleanup is durably confirmed. The schema matrix and every test tier enumerate both
flag states and all failure boundaries.

Current post-fold hashes entering round 10 are ledger
`f6102293747a1d94cf01655aee88b3c6f7f912c8c3c6aef1897f170a627b4f97` and foundation
`573985c815f5a51fccc4552776d6b997ea54a2e4fd8c2488a0df80368c4622b2`.

**Current verdict: not converged.** Round 9 contained a DESIGN finding; quiet-pair count remains zero.

### External-fold round 10 — admit both atomic-replace durability outcomes

All three lenses returned DESIGN 1 on the same boundary (security also reported one duplicated
fragment, absent in the current body): after the witness is atomically rewritten false, failure of
its parent fsync cannot guarantee whether restart observes old true or new false. The live process
now conservatively retains maintenance and closed mutations. Restart explicitly admits both safe
outcomes: true takes pending/no-sibling confirmation; false takes clean CURRENT steady state.
Tests no longer require impossible flag stability and instead prove unchanged NEW authority and
correct maintenance behavior under both persistence outcomes.

Current post-fold hashes entering round 11 are ledger
`f6102293747a1d94cf01655aee88b3c6f7f912c8c3c6aef1897f170a627b4f97` and foundation
`672fb5a6688b7ec57908d31b9bfac56f88bda81b2fa8ab918f51094fe4509282`.

**Current verdict: not converged.** Round 10 contained DESIGN findings; quiet-pair count remains zero.

### External-fold round 11 — first fully clean round

All three independent lenses returned DESIGN 0 / PRECISION 0 on the exact unchanged bodies: ledger
`f6102293747a1d94cf01655aee88b3c6f7f912c8c3c6aef1897f170a627b4f97`, foundation
`672fb5a6688b7ec57908d31b9bfac56f88bda81b2fa8ab918f51094fe4509282`. No actionable finding
remained. This is clean round one; the technical bodies remain unchanged for the required second
consecutive review.

**Current verdict: not yet converged.** Quiet-pair count is one of two.

### External-fold round 12 — zero DESIGN, one copy precision fold

All three lenses returned DESIGN 0 on the identical round-11 bodies. Security and decisions returned
PRECISION 0; integration found one duplicated word (`effective effective`). The technical design
therefore passed its second consecutive zero-DESIGN review, but the copy edit changes the ledger
hash, so the stricter fully-clean unchanged-body pair restarts rather than claiming convergence.

Current post-copy hashes entering round 13 are ledger
`a34e4780bef1943dfa5437f1405e027ddbe14dc4538b3f1cccd76b59420ab435` and foundation
`672fb5a6688b7ec57908d31b9bfac56f88bda81b2fa8ab918f51094fe4509282`.

**Current verdict: technically zero-DESIGN twice, not yet fully clean on unchanged hashes.**

### External-fold rounds 13–14 — file-growth race resets the pair

Round 13 was fully clean across all three lenses. In round 14, integration and decisions returned
0 DESIGN/0 PRECISION, while security found one DESIGN gap: path `stat` followed by an uncapped read
could race file replacement/growth and violate the claimed 8 MiB hard bound. The fold now requires
no-follow open, same-descriptor `fstat`, and an 8 MiB+1 capped read for every normal and recovery
authority validation; digest/size bind exactly those captured bytes. Unit and production-E2E tests
race replacement/growth and prove no oversized allocation or publication.

Current post-fold hashes entering round 15 are ledger
`a34e4780bef1943dfa5437f1405e027ddbe14dc4538b3f1cccd76b59420ab435` and foundation
`86da52e791c8ab01ebc6fd204a5c7ba2f86f106d89a73a89b7b59f6eb4e75eaa`.

**Current verdict: not converged.** Round 14 contained a DESIGN finding; the clean-pair count resets.

### External-fold round 15 — complete the three-tier race proof

Security and decisions returned 0 DESIGN/0 PRECISION. Integration returned 1/0 because the
same-descriptor capped-read race was named at unit and production-E2E tiers but omitted from the
required integration tier. The integration contract now races both replacement and in-place growth
through the real public pool/load boundary, caps consumption at 8 MiB+1, requires the closed typed
size refusal, and proves no partial array/index publication across normal and recovery entry points.

Current post-fold hashes entering round 16 are ledger
`a34e4780bef1943dfa5437f1405e027ddbe14dc4538b3f1cccd76b59420ab435` and foundation
`f509aa8bc30ff3f7eabe252c71a78fcd85115e3c0284cfd9e4e7ddd0679f81c4`.

**Current verdict: not converged.** Round 15 contained a DESIGN finding; the next exact-body review
starts a new clean-pair sequence.
