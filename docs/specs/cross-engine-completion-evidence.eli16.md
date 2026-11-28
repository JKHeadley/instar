# Instrumented Cross-Engine Local Completion Evidence — ELI16

The current “verify before saying done” check has one large blind spot: it knows how to read Claude
Code’s activity record, but it deliberately does nothing for Codex, Gemini, pi, Grok Build, or
Instar’s own jobs. That was honestly documented, yet it still means an agent-general safety rule is
really a Claude-only feature.

This design replaces the Claude transcript dependency with one Instar-owned protocol. It works the
same way for every engine when the session runs through Instar’s instrumented launcher. The
launcher owns the turn identity, the registered local action seam, the child process, and the final
response shown to the user. A normal standalone terminal session is not covered and stays
unknown.

The first important simplification is scope. This version verifies only deterministic local work:
running a named test suite, running a named build, executing a registered local command, or making
a file change whose exact before-and-after state can be proved. It does not claim that a git push
reached a remote, a message was delivered, a cloud or database change committed, or an MCP/vendor
worker finished. Those actions often need asynchronous provider receipts and workflow machinery.
They are explicitly unsupported here and need separate future designs. The spec also does not
claim that an unconfined CLI performed no hidden side effect.

We did characterize the requested model pathways. The older benchmark found strong candidate
routes through GPT-5.5, Sonnet 4.6, and Gemini 3.1 Flash-Lite, while one Opus coding-harness route
was disqualified. But the live doorway, decision-quality, and divergence services were unavailable
on this agent, and the benchmark uses transcript-shaped inputs rather than this design’s structured
evidence. Those results are useful research, not runtime authority. This release never asks a model
whether another model really completed work.

The research-only starting routes are: GPT-5.5 through pi for Claude, Gemini, Grok, and
Instar-native, with Gemini Flash-Lite or Sonnet 4.6 as backup; Sonnet 4.6 in a clean Claude session
for Codex and pi, with Gemini as backup. These routes may guide a future benchmark rerun, but they
cannot affect a verdict, rollout decision, or fallback while the live characterization services are
dark.

The launcher—not the model—decides what must be reported. Before each registered local action, the
supervisor creates a signed action identity and records its safe action kind and target identity.
At the end of the turn, the launcher builds the complete candidate list from every mediated action
intent and result. The model cannot leave an inconvenient action off the list, add a fake action,
or decide that an action should be described as completed. It only echoes the launcher’s candidate
digest to close the turn.

Qualification uses the same closed-world discipline. Each engine/build/operating-system/action
row is identified by one exact tuple that also binds the launcher, renderer, verifier, producer,
parser, codec, schema, registry, and fixture-runner bytes. Before a qualification window opens, an
independently signed candidate freezes that tuple and its planned tests. Afterward, receipts must
match that exact candidate. A newly substituted binary, helper, parser, or renderer cannot borrow
another tuple’s measurements.

That list also has closed “unsupported action” and “unknown action” entries, created before the
system looks for a supported schema. A storage failure keeps the candidate visible as unknown. The
turn may execute at most 15 actions; the reserved final entry reports an action-limit attempt and
rejects it before execution. This prevents capacity pressure from creating invisible work.

For a canonical final answer, the launcher renders every candidate from fixed templates. Each line
shows the action, result, verification status, evidence basis, and a safe next step when something
is unknown or contradicted. An empty candidate list cannot say “done.” A missing, late, mismatched,
or repeated-differently close makes the affected clauses unknown.
The block always says that verification applies only to the listed local mediated actions. It may
not show a global “task done” badge or checkmark.

Evidence basis is clause-level, not a flattering label applied to the whole action. Every verified
or contradicted clause must name the exact source class that supports it; an unknown clause must not
claim any basis. This keeps one well-proved predicate from lending authority to a different weak or
missing predicate in the same action.

The engine can still provide a natural explanation, but it goes into a separate “Unverified
commentary” container. That text is escaped so Markdown, terminal controls, bidirectional text,
HTML, or fake verification headings cannot hide the label or imitate the launcher’s evidence
block. If Instar cannot prove that it owns the CLI’s final output stream, it shows no
evidence-backed block at all.

Output ownership is tested separately for each engine and build. Instar must own the process group,
terminal, stdout, stderr, cancellation, and final sink. Tests include late output, ignored
cancellation, hung processes, descendants, terminal resizing, restarts, and reinstalls. A startup
canary is time- and memory-bounded. Its proof expires and is invalid after a reboot, reinstall, or
supervisor restart. A failed proof falls back to visibly unverified freeform output.
The proof also binds the executable's resolved identity and content hash, so replacing a binary or
control adapter invalidates it immediately rather than inheriting the old proof for up to a day.

This stream contract is not a sandbox claim. A helper daemon or vendor worker that performs work
outside the registered action seam is unsupported. If it can write to the user-facing response, the
stream proof fails. If it performs a hidden side effect, this design does not count or verify that
effect.

Every supported local action has an exact success rule. A test needs the owned process result plus
a parser-confirmed report for the exact suite and configuration. A build needs its exact bounded
report. A file write needs a supervisor-owned operation and matching before/after versions or
digests. A local command proves only that the registered command ran with the matching result; it
does not automatically prove a larger state change.

“The tool returned success” is therefore not enough. A stale report, different target, already
matching prior state, missing before-version, concurrent writer, or conflicting evidence becomes
unknown. An explicit matching failure becomes contradicted. Missing evidence is never treated as
contradiction.

Each admitted action row has two tested, write-isolated sources. The Instar supervisor journal is
the normal primary. A deterministic action verifier or proven native event supplies redundancy.
For the initial dark seed—an Instar-native test run—the supervisor records intent and process
result, while the test runner writes a content-addressed report through a narrow capability the
engine cannot forge and a read-only parser checks it. Tests independently corrupt or drop both
producers and stores. If the two sources disagree, the result is unknown.

The user also sees what kind of evidence supported a verified line. “Trusted local supervisor”
means the owned local runtime observed it. “Independent local producer” means another local
producer and store supplied the matching report. “Authoritative local state” means a read-only
verifier proved the exact local state transition. None of those labels pretend that another host
or remote provider independently confirmed the result.

Evidence is deliberately small and private. It contains signed opaque identities, registered
action kinds, target hashes, result enums, evidence basis, and safe artifact references. It never
contains prompts, commands, arguments, raw results, transcript paths, filenames, user prose,
secrets, or provider identifiers. The database, sidecars, and write-isolated reports live in one
owner-only private directory that backups, state sync, and every dashboard file route are
hardcoded to deny; only the scrubbed evidence API can expose a projection.

The local evidence projection is bounded: fixed envelope and action counts, two revisions per
action, limited live rows and quarantine rows, a fixed database ceiling, a bounded writer queue,
and thirty-day retention. Per-session and per-engine sublimits plus small protected engine reserves
keep one noisy session or engine from consuming every other engine's daily diagnostic capacity.
It is an extension of Instar’s existing local recorder, not a workflow
engine: there are no provider callbacks, retries, tombstones, dispatchers, consumer offsets, or
unbounded replay. Disk pressure, queue pressure, database contention, revision overflow, or a
conflict produces unknown instead of evicting live proof or fabricating a success.

Raw evidence stays on the physical machine whose process it proves. Other enrolled machines read a
bounded, versioned scrubbed projection with source machine and verification basis preserved. V1
pins an in-flight turn to that origin machine. If serving ownership moves, the old engine loses its
response sink and the new host must start a new logical turn; it cannot continue or close the old
one. This intentionally avoids claiming that Instar's current serving lease is a linearizable
per-turn action counter—it is not. Transparent running-turn transfer needs a later foundation and
specification.
The new host also never auto-replays an action-bearing interrupted prompt: the durable inbound
record says the prior effect may already have happened, sends one unverified interruption, and
waits for an explicit new instruction unless an action-specific idempotency/state proof exists.
After a continuity-key outage, a bounded authenticated reconciliation can publish scrubbed mappings
without moving local authority. Conflicting or unavailable evidence remains unknown. The local
projection is excluded from backups because restored host-keyed evidence cannot safely become new
local authority; lost local history is shown as unavailable rather than reconstructed.

Production timing values are measured, not guessed. Dark capture runs for seven days at the
intended concurrency and records every success and failure outcome. A host/action row needs at
least 99 percent durable capture, plus bounded p99 result and turn-close times. An expired or failed
measurement disables only that row’s authority. It cannot silently widen a deadline or weaken the
success floor.

An Instar-native row may prove the plumbing in dark mode, but it cannot display a positive verdict
by itself. Claude Code, Codex CLI, Gemini CLI, pi CLI, Grok Build, and Instar-native must each pass a
real action/control/close fixture, failure corpus, and seven-day calibration in the signed global
generation. Each host then enables only engines that are actually installed, enabled, and proven
there; a Codex-only host does not need five unrelated vendor credentials. No engine is promoted
because another engine worked, and rollback cannot quietly restore Claude-only authority. Conflicting
or stale rollout records fail to visibly unverified output.
Promotion and rollback commands form a signed, monotonic chain; rollback is a newer command, not a
bit that can be undone by replaying an old promotion. Standard TUF update metadata pins the exact
bounded public npm package, which contains only unlinkable pool/target tokens and scrubbed metadata;
an npm tag is never trusted as the current head. A separate nonce-bound, independently signed
freshness response proves which TUF head is current. A global 64-host V1 ceiling keeps the service
load and rollback guarantees measurable; additional hosts stay dark until capacity is expanded.

The membership list and current-head answer are not trusted merely because they came from the
publisher. Membership is signed by a dedicated 2-of-3 authority with separated custody, and each
source signs its own status. The current-head response is independently signed and bound to a fresh
nonce. Signer-facing requests are fixed, scrubbed, non-cacheable, and narrow enough that an HSM
cannot be used as a general signing oracle.
Each ordinary command is one bounded snapshot of all admitted hosts across all pools and rings, so
64 one-host pools can be renewed without issuing 64 separate commands. Every host gets a short-lived,
unlinkable lease entry and a small inclusion proof from the signed current census. Publication is a
durable prepare→sign→package→TUF→activate transaction: after any crash, the pipeline must finish the
same exact candidate and cannot create a competing command from the same predecessor. Seeing TUF
metadata before activation only turns evidence consumption off until the matching activation lands.
A new or restored host gets a new private enrollment nonce and cannot consume positive
evidence until a later command targets it. It may still run capture-only dark to produce
qualification evidence. If freshness is unavailable, consumption stays off and unverified.
Inbound adapters also need replay proof before they can show canonical evidence. Current Slack
delivery lacks that foundation, so Slack keeps its existing action behavior but its whole response
stays visibly unverified; this design does not block Slack actions.
The rollout remains observe-only, so an evidence verdict does not block the final response. Any
verdict-based blocking needs a separate operator-approved design based on measured false positives
and false negatives. Direct user-channel bypass is different: an engine that can send around the
launcher cannot earn stream ownership or a positive evidence block.

Operators still need to diagnose why a locally captured record was withheld. Private Process
Health therefore distinguishes: no captured evidence, captured and display-authorized, captured
but held by global control, and captured but held by the local row. These states never leak private
evidence or upgrade the user-visible verdict; they only make a fail-closed outcome explainable.

The CLASS-level process fix is CI coverage. Every build-supported engine must have an explicit row
and completion-specific corpus. Dark rows may remain uncharacterized, but an observe-only row must
have real fixtures, deterministic redundancy, stream ownership, calibration, and a named rollout
generation. That closes the development gap that allowed an agent-general rule to ship with a
single-engine implementation.
The positive engine label also requires an exhaustive manifest containing every registered or
observed mediated row—including unsupported and unknown rows—and at least 95 percent
instrumented-turn coverage. Rollout configuration cannot hide an inconvenient row to earn a better
badge.

The result is smaller than the earlier umbrella design and more honest. It does not solve every
kind of completion claim. It does give every supported engine the same deterministic local
protocol, makes unsupported work explicit, and ensures uncertainty can never masquerade as
verified completion.
