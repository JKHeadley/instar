# Codex 0.144 Internal-Call Linger — Plain-English Overview

> The one-line version: after the codex tool got upgraded to 0.144, my quick behind-the-scenes "thinking" calls that run on codex started failing ~92% of the time — not because the answer was wrong, but because codex now dawdles for 16-30 seconds AFTER it already finished answering before it actually shuts down, and my 30-second cutoff was killing those already-done calls. This fix takes the answer the moment codex says it's done, instead of waiting for the slow shutdown.

## The problem in one breath

Lots of my internal machinery — the little classifiers, gates and sentinels — don't run on Claude; they shell out to the `codex` command-line tool for a fast, cheap judgment. On 2026-07-09 the host's codex was upgraded from 0.137 to 0.144 (needed for a newer model). Right after, one of those internal callers (the topic-intent extractor) went from ~28% errors to 46 failures out of 50 calls in an hour. The tell-tale clue: many of the "failed" calls had already been billed tokens — meaning codex HAD answered, and yet I still recorded a failure.

## What I found (the real cause)

I reproduced my exact codex call — same arguments, same environment, same way of feeding the prompt in — and watched the raw event stream. codex 0.144 emits its final answer and a `turn.completed` event at, say, the 20-second mark... and then the process just **sits there for another 16 to 30 seconds** before it writes its result file and exits. The delay gets worse the more of these calls run at once. My code waited for the process to fully exit before accepting the answer, so my 30-second timeout fired *while codex was still dawdling on an already-finished call*, and I threw the completed answer away as a "timeout."

Two things made this a 92%-failure storm rather than a nuisance:
- The already-finished answer was discarded even though it was right there in the event stream.
- Each dawdling process kept holding one of my limited "concurrent codex" slots for those extra 16-30 seconds, so the whole queue backed up and even more calls blew past 30 seconds.

Worth noting: the original hunch (that a new codex "warning" message was being mis-read as an error) turned out **not** to be the cause for these internal calls — that warning only appears on a different code path (interactive sessions), never on the quick-judgment path. The real culprit was the shutdown dawdle.

## What this changes

codex already tells me, in its own structured event stream, both its final answer (an `agent_message` event) and that the turn finished (`turn.completed`). So the moment I've seen BOTH, I take the answer I already hold and finish the call — I no longer wait for codex's slow exit. I give the process a tiny grace window (0.75s) to exit on its own; if it's still dawdling after that, I settle with the answer in hand and clean up (reap) the lingering process so its slot frees immediately.

The result: a call finishes at roughly the moment codex actually answers (~20s), not 16-30s later — and the freed-up slots let the queue drain, so fewer calls hit the timeout at all.

## The safeguards in plain terms

- **It can't turn a real failure into a fake success.** I only take the early answer when codex emits its own "the turn completed successfully" signal AND a real answer. A genuine failure emits `turn.failed` (not `turn.completed`), so it still fails exactly as before. A call that never finishes still times out and fails.
- **A codex that exits promptly is completely unchanged.** If the process shuts down within the 0.75s grace (like the pre-0.144 versions did), I read the result the old way, byte-for-byte. The new behavior only kicks in when codex actually dawdles.
- **Same content, same trust.** The answer I take from the event stream is the identical text codex would have written to its result file — it writes that file FROM that same message. It's a typed, structured field I parse safely, not loose terminal text.
- **Nothing about routing or gating changes.** This is purely inside the codex adapter's plumbing.

## What's NOT changing

- The kill-switch that reverts codex calls to the old plain-output mode still works.
- The token-accounting is unchanged — a completed call still records its real token usage.
- A separate, smaller issue (some fallback "try the pi tool instead" attempts timing out at a 5-second bound) is intentionally left as a tracked follow-up — the real fix there is that these codex failures were what triggered those fallback attempts in the first place, and this change removes the trigger.

## What you need to decide

Nothing — this is a bug fix that ships on by default and reverts cleanly if ever needed. The one open follow-up, noted above, is whether to later give that "try pi instead" fallback its own longer timeout; I've deferred it because the properly-scoped version needs its own design and this fix already removes most of what was triggering it.
