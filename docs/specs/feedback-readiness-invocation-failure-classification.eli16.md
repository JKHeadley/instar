# A rate limit no longer switches the feedback sorter off (plain-English overview)

Governing spec: `docs/specs/feedback-factory-operating-drain.md` (converged and approved). This change restores two of its rules; it adds no new rule.

## What happened

Feedback reports from Instar agents are sorted by a model the operator approved: it decides which reports are ready to become work items. On Tuesday 2026-10-14 the lane that model runs on was rate-limited for a stretch. Eight sorting calls over twelve hours came back "429 Too Many Requests" while every other kind of call on the account worked. The third refusal in a row tripped a safety brake that switches the sorter off until the operator approves it again on the dashboard. Nobody was told, and the sorter stayed off for four days.

Three things were wrong, and the first is the real one:

1. **The brake fired on the wrong kind of failure.** The governing spec lists exactly what may switch the sorter off: an unauthorized promotion, an answer in the wrong shape or from the wrong model, too many duplicates, falling precision, the daily spend cap, or the prompt or model drifting from what was approved. A provider saying "try later" is on none of those. The spec also says the operator's approval "is never the default throughput chokepoint", and a four-day stop that only a PIN can clear is exactly that.
2. **The error said nothing.** The sorter's own record said only "Codex CLI error (exec --json, exit 1)". In JSON mode the Codex tool reports why it failed on its normal output, not on the error stream, and the code kept only the error stream. The cause was found four days later by reading the tool's private logs.
3. **Nothing announced it.** A separate change (the pause alarm) already fixed the silence for genuine pauses. But once a rate limit no longer pauses anything, that alarm can never fire for it, so a long stretch of failed calls needs its own notice.

## What changes

- **A failed call never switches the sorter off.** A timeout, a provider error, a rate limit, or an answer the checks rejected is counted and the call is simply made again at the next scheduled run, exactly as before for the first two failures. There is no third strike. The brakes the spec names (spend cap, a different model or prompt answering, an answer in the wrong shape) still switch it off at once, and the operator's dashboard approval is still the only way back from those. Nothing is added that retries on its own between runs: the spec explicitly keeps that out of this part of the system until a shared retry foundation exists.
- **The error now says why.** When a Codex JSON-mode call fails, the last error message it printed is carried into the recorded failure, cut to a bounded length and scrubbed of anything that looks like a secret. The next "exit 1" will read "exit 1 — last event: exceeded retry limit, last status: 429 Too Many Requests".
- **Progress is visible, and a long stall is announced once.** The drain's status now reports how many runs in a row produced no usable answer, since when, and when one last succeeded. After six such runs in a row (about three hours at the half-hour cadence) the drain raises one attention item saying that sorting is not making progress, naming the last failure, and saying plainly that nothing is paused and nothing needs approval. A later success closes that episode; a later outage gets a fresh notice. The same episode is never announced twice.

## What does not change

- The operator's PIN gate is untouched. The brakes that need it are the same brakes as before, minus the one the spec never listed.
- Nothing restores a paused sorter automatically, and nothing retries out of cadence.
- Batch sizes are untouched. The failed calls on 2026-10-14 were ten candidates each (one was four); the wall was the model lane, not the request size.

## What you need to decide

Nothing. This is a restoration of the approved spec's own rules plus better diagnostics. If the sorter is currently paused by the old three-strike brake, one dashboard approval restores it, as before; after this change that brake cannot trip again.
