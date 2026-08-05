# ⛔ CORRECTED — this document named a conclusion where it should have named a quantity

**Original title:** *"the memory gate has refused 626 job spawns on a machine under no pressure."*
**That framing is withdrawn.** It was banked at 12:00Z and corrected at 12:18Z after the manager
interrupted off-slot to say: *"establish which quantity the gate actually reads… I would rather the
record name the quantity than the conclusion."*

**He was right, and the irony is exact:** I committed a measure-vs-certify error, about a memory gate,
inside the audit whose subject is measure-vs-certify.

---

## What the gate actually reads — settled from source

```ts
// src/monitoring/hostMemoryPressure.ts:119
hostFreeMemPct = 100 - readSystemMemoryPressure().pressurePercent
// → spawnSync('vm_stat') → parseVmStat
// doc comment: "macOS is read truthfully (free+inactive+purgeable), not raw free pages"
```

**The gate reads RAM availability. It does not read swap at all.**

### Both competing hypotheses are refuted

| hypothesis | verdict |
|---|---|
| **Mine:** the gate refuses wrongly on a healthy machine | **unsupported.** It reads 18.2% against a ~25% threshold and refuses. It is behaving exactly as designed on the quantity it reads. |
| **The manager's:** it may read swap headroom, so 626 refusals correctly gate an exhausted resource | **refuted.** Swap is not an input to this gate. |

**Both of us reasoned from a number to a conclusion without establishing what the number was of.** The
93–97% swap figure and the 39–43% OS free figure were both true simultaneously, and **neither is what
the gate consumes.**

### What remains genuinely open, and is not mine to settle

Whether "18.2% free RAM should refuse a spawn" is the right policy. The gate's metric and the OS's
pressure facility disagree by ~25 points because they compute differently (the OS credits compressed
pages). **That is a calibration question with a real answer, and I do not have the evidence for it.**
Recording it as open rather than resolving it by assertion.

---

## The finding that SURVIVES, and it is sharper

Strip out the gate question entirely and this is still true:

> **A job has now failed 492 consecutive times and nothing has paused it.**

| | |
|---|---|
| refusals in the window | 626 |
| worst consecutive streak | **492** |
| alert deliveries in the same window | **57** |

**So this is not silent.** Alerts fired. The system noticed. **What it did not do is stop retrying a job
that cannot currently succeed** — 492 attempts at a spawn that is refused every time.

### And the guard whose job that is remains unbuilt

`CrashLoopPauser` — auto-pause of runaway jobs — is **still never constructed** (`new CrashLoopPauser`
resolves nowhere in source). This is Phase A's finding, unchanged, and its live consequence has grown
from a 477-streak to a **492-streak**.

Its exclusion reason, verbatim (`guardManifest.ts:1149`):

> *"Auto-pause of runaway jobs is scheduler-internal mechanics; surfaced via `scheduler.enabled` + job
> state, not its own guard."*

**That reason answers a different question than the guard's function.** The claim is about *surfacing* —
and surfacing works, as the 57 alerts show. **The guard's purpose is *pausing*, and nothing pauses.**

> **The presence-not-truth defect, with a live consequence measured in 492 retries:** the reason is
> twelve-plus characters, it is plausible, it passed the lint, and it is about the wrong thing.

---

## The method lesson, since I supplied it against myself

I measured swap (97%), measured OS-free (43%), found them contradictory, and **published a conclusion
about a gate whose input I had not read.** The correction cost one `grep` for the function definition.

**Name the quantity before naming the conclusion.** Both numbers were real; neither was the gate's.
