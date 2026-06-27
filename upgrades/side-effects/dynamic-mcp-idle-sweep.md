# Side-effects review — dynamic-MCP idle-offload sweep (orchestration)

**Change:** New `src/monitoring/McpIdleOffloadSweep.ts` — the automatic
"offload a heavy MCP server once it's been idle a while" trigger. Stateful
orchestration over INJECTED deps (proc listing, session→topic, signature→server,
mid-tool-use, keep-warm, requestOffload). 9 unit tests.

## 1. Blast radius
Zero at runtime. No importer yet — nothing ticks it until the background-interval
wiring lands (a thin follow-up). The whole feature is also behind the dark
`sessions.dynamicMcp.enabled` flag.

## 2. Reversibility
Fully reversible — delete the file + tests. No persisted state (the idle clocks are
in-memory and pruned).

## 3. State / data touched
None on disk. An in-memory Map of per-proc idle clocks, pruned each tick for procs
that vanished (cannot grow unbounded).

## 4. Failure modes
Fail-closed by construction: a busy OR unknown(null) mid-tool-use resets the idle
clock (never ages an ambiguous session toward an offload); an unmapped server or a
non-topic-bound session is skipped; a thrown requestOffload never breaks the sweep.
It delegates the actual offload to the authorization-gated driver, so the same
"agent can't self-approve" + "abort if mid-tool-use" + capture-then-reap guarantees
apply — the sweep adds no new destructive path of its own.

## 5. Security / authority
No new authority. An idle-offload it triggers goes through the SAME
authorization-gated requestOffload as an explicit request — on a non-preapproved
session it returns needs-approval (no silent restart).

## 6. Framework generality
Framework-neutral orchestration; the mid-tool-use dep is framework-aware upstream.

## 7. Tests
9 unit tests: disabled no-op; below-window no-offload; offload once the window is
crossed; mid-tool-use reset (busy + unknown); keep-warm exclusion; dry-run logs-only;
non-topic-bound skip; clock pruning. tsc clean.
