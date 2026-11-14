# Local verify survives lifeline restarts — the plain version

## What went wrong

Before a pull request can merge, the server runs the whole test suite on it. That run is called a local verify, and it takes about 45 minutes. Only one runs at a time, so the PRs wait in a line.

On the night of 2026-10-25, PR 2350 was first in that line for hours and never got a finished run. The logs showed why:

- Two of the server restarts that night came from software updates. Those already wait for a running check to finish, and they did.
- The restart that actually killed PR 2350's check (23 minutes in) came from somewhere else: the lifeline. The lifeline is the small helper process that receives Telegram messages and keeps the server alive. When it falls 20 versions behind the server, it restarts itself to catch up. As part of that restart it also shut the server down, and nothing asked whether a check was running.
- After every restart, the server queues a fresh check of `main` itself, and in the cautious state it boots into, `main` goes first. So the PR went to the back again.
- The killed run was quietly un-counted, so the line said "0 attempts" no matter how many runs died. The alarm for a stuck line only watched the clock (3 hours), and that alarm was never connected to anything a person would see. It only wrote a line in a log file.

## What changes

1. **The lifeline's catch-up restarts leave the server alone.** When the lifeline restarts only to catch up with the server's version (it fell behind, or an update told it to move onto the new code), the server is already current. So the lifeline now just stops watching the server and exits, and the new lifeline picks the running server back up, even if the server is too busy to answer at that moment. A check that is running keeps running. A restart because the server is unhealthy, or one the operator asks for, still restarts the server as before, and if one of those arrives in the same second as a catch-up restart, the server is still stopped.
2. **A killed check counts.** If a server stop kills a check, the attempt stays on the books and the PR gets an "interrupted" mark that survives the restart. If a PR's check is killed twice, the stuck-line alarm goes off right away instead of waiting for the 3-hour clock.
3. **The alarm reaches a person.** The stuck-line alarm now creates one attention item per PR, in plain words: "PR #N cannot finish its check", saying whether restarts kept killing it or it just waited too long.
4. **An interrupted PR goes first.** After a restart, a PR whose check was killed starts before the fresh `main` check, so it is not pushed back by the very restart that interrupted it. The one exception: if `main` is known to be broken, fixing `main` still comes first, as today. The mark is used once, when the check starts again, so it cannot keep cutting in line.

## What stays the same

- Update restarts still wait for a running check, as before.
- The check is not resumed half-way: its test groups run side by side, so there is no smaller finished piece to keep. It starts again, but first in line.

## Safeguards

- If the server is genuinely gone when the new lifeline starts, it starts a fresh one, which is what happens today. If it is there but busy, the new lifeline watches it with the usual patience rather than killing it on arrival.
- Two independent outside reviews (GPT-6 Astra and Gemini 4 Argon) read the plan and the code; every finding they raised was fixed, except one test shape that cannot run without talking to GitHub, which is covered another way.
- The change went through the same check line it fixes. Its first run came back red on one housekeeping test (a code-hygiene marker was missing on an error handler, no behavior involved); that was fixed and the check re-run before merging.
- Nothing new is blocked or refused. The changes only move a PR forward in the line and raise an alarm sooner.
- Undoing it is a plain revert. The two new fields saved with the line are optional, and an older server ignores them.

## What you need to decide

Nothing. This is a small, reversible fix to a bug that was stopping every PR from merging.
