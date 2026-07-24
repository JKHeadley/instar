# Instrumented Cross-Engine Local Completion Evidence — ELI16

The current “verify before saying done” check has one large blind spot: it knows how to read Claude
Code’s activity record, but it deliberately does nothing for Codex, Gemini, pi, or Instar’s own
jobs. That was honestly documented, yet it still means an agent-general safety rule is really a
Claude-only feature.

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

The launcher—not the model—decides what must be reported. Before each registered local action, the
supervisor creates a signed action identity and records its safe action kind and target identity.
At the end of the turn, the launcher builds the complete candidate list from every mediated action
intent and result. The model cannot leave an inconvenient action off the list, add a fake action,
or decide that an action should be described as completed. It only echoes the launcher’s candidate
digest to close the turn.

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

Each admitted action row has two tested sources. The Instar supervisor journal is the normal
primary. A deterministic action verifier or proven native event supplies redundancy. For the first
seed row—an Instar-native test run—the supervisor records intent and process result, while the test
runner writes a content-addressed report to a separate store and a read-only parser checks it.
Tests independently corrupt or drop both producers and stores. If the two sources disagree, the
result is unknown.

The user also sees what kind of evidence supported a verified line. “Trusted local supervisor”
means the owned local runtime observed it. “Independent local producer” means another local
producer and store supplied the matching report. “Authoritative local state” means a read-only
verifier proved the exact local state transition. None of those labels pretend that another host
or remote provider independently confirmed the result.

Evidence is deliberately small and private. It contains signed opaque identities, registered
action kinds, target hashes, result enums, evidence basis, and safe artifact references. It never
contains prompts, commands, arguments, raw results, transcript paths, filenames, user prose,
secrets, or provider identifiers.

The local evidence projection is bounded: fixed envelope and action counts, two revisions per
action, limited live rows and quarantine rows, a fixed database ceiling, a bounded writer queue,
and thirty-day retention. It is an extension of Instar’s existing local recorder, not a workflow
engine: there are no provider callbacks, retries, tombstones, dispatchers, consumer offsets, or
unbounded replay. Disk pressure, queue pressure, database contention, revision overflow, or a
conflict produces unknown instead of evicting live proof or fabricating a success.

Raw evidence stays on the machine where it was created. Other enrolled machines may read a
scrubbed projection with the source machine and verification basis preserved. Conflicting terminal
evidence remains unknown. The local projection is excluded from backups because restored host-keyed
evidence cannot safely become new local authority. After restore, new canaries and new evidence
rebuild authority; the dashboard clearly marks the cold-start interval.

Production timing values are measured, not guessed. Dark capture runs for seven days at the
intended concurrency and records every success and failure outcome. A host/action row needs at
least 99 percent durable capture, plus bounded p99 result and turn-close times. An expired or failed
measurement disables only that row’s authority. It cannot silently widen a deadline or weaken the
success floor.

The first release is one Instar-native test-run row proving the full launch-to-verdict path. Claude
and Codex then enter dark and dry-run for local tests, builds, and causal file writes. Gemini and pi
follow only after their own real fixtures pass. No engine is promoted because another engine
worked. The rollout remains observe-only, so “unknown” is visible but does not block a message.
Any blocking behavior needs a separate operator-approved design based on measured false positives
and false negatives.

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
