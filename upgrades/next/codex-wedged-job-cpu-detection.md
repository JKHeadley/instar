# Codex wedged-job detection (CPU-stall, not process existence)

## What Changed

A scheduled codex job (`codex exec --json`) can wedge: the process stays alive but
makes no progress — 0% CPU, no output. One such job sat wedged ~12h undetected. The
StaleSessionBackstop (which raises a "stale but unkillable" attention item, never
kills) missed it because its forward-progress check used process **existence**:
`hasActiveProcesses` walks descendant processes and returns true if any non-baseline
child is alive — which a wedged-but-alive job is. So the backstop read it as
"active" and never escalated. (Conversational claude sessions are saved by transcript
growth, so only jobs — whose codex transcript doesn't resolve — were exposed.)

The fix gives the backstop a real CPU signal: `SessionManager.descendantCpuSeconds`
reads each non-baseline descendant's accumulated CPU time, and the backstop compares
the delta across its two snapshots — real CPU *used* in the interval, not mere
existence. This is scoped to **job sessions** (which have no legitimate-idle state):
a job that uses no CPU between snapshots reads as no-progress and escalates.
Conversational sessions keep the existing existence-based check, so a legitimately-idle
session with a background process is *not* falsely flagged.

## What to Tell Your User

If one of my scheduled background jobs ever freezes — alive but doing nothing — I'll
now actually notice it and flag it for attention, instead of mistaking "the process
is still running" for "it's making progress." Before, a job could sit stuck for hours
unseen; now a job that stops using any CPU gets surfaced. This only adds an
attention notice — it never kills anything — and it doesn't change how I treat your
normal interactive sessions.

## Summary of New Capabilities

- The stale-session backstop now detects a wedged-but-alive **job** (0% CPU, no
  output) and raises its existing attention notice, where it previously read process
  existence as "progress" and stayed silent.
- New `SessionManager.descendantCpuSeconds` (accumulated CPU-seconds of a session's
  real children) + `parseProcTimeToSeconds` — a CPU-delta progress signal.
- Scoped to job sessions only; conversational sessions are unchanged (no new
  false-positives on idle-with-a-background-process). Never kills — attention-only.

## Evidence

- 19 tests: `stale-session-backstop` (13 — incl. wedged-job→escalate, busy-job→no,
  conversational-idle-with-bg→no-regression) + `parseProcTimeToSeconds` (6, covering
  `MM:SS` / `MM:SS.ss` / `HH:MM:SS` / `DD-HH:MM:SS`). `tsc --noEmit` + `pnpm build` clean.
- The escalation path is unchanged (still attention-only, never a kill); only the
  forward-progress test gains a CPU-delta requirement for job sessions.
