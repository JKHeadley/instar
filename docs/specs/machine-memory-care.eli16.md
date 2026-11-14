# Machine memory care: the plain-English version

## What happened

On 14 November the M5 (one of the computers that runs our tests) ran out of memory. Its swap space, the overflow area on disk the Mac uses when memory is full, was 17 of 18 GB full. Apps showed out-of-memory errors, the screen was a mess, and Justin had to restart it by hand.

Three things in Instar let that happen:

1. **Instar's machine health check only looked at "free memory".** A Mac that is pushing memory out to disk all the time can still show a healthy-looking free-memory number. So Instar kept calling the M5 healthy.
2. **Our test runs left helpers behind.** Some tests start small background programs, such as terminal sessions for end-to-end tests. When a run ended, those programs were not always stopped. On the M5, 66 of them had piled up over as long as 18 days, using 6.6 GB. The Mac Studio has a few as well right now.
3. **Nothing pulled a struggling machine out of the test line.** Because the health check said "fine", the Mac Studio kept sending the M5 full test runs.

## What changes

**Swap now counts.** Every 15 seconds each machine reads how much swap it is using and whether it is writing to swap right now. Swap above a tenth of the machine's memory counts as memory pressure when there is live evidence: the machine is still writing to disk, memory is also tight, or the system itself reports pressure. With a quarter of memory in swap and the machine still swapping, it is marked "impaired", the worst health level. Swap left over from earlier, on a machine that now has plenty of room, does not count, so a machine that recovered is not kept out until its next restart.

**A machine short of memory steps out of the test line by itself.** If the Mac Studio is short of memory, it stops starting its own tests but keeps handing them to healthy machines. If it stays short for a long time, it still runs one test every 45 minutes, so merging never stops completely. If the M5 (or any helper machine) is short of memory, the Studio stops sending it tests, and the M5 also turns down any test offered to it. Each time this happens you get one notice saying which machine and why, in plain words. When memory recovers the notice closes, and the machine rejoins without anyone doing anything.

**Test runs clean up after themselves.** At the end of every run, the test runner ends any program still pointing into that run's own folders. A second check, every 10 minutes and at startup, catches anything a crashed or killed run left behind. It only touches leftovers: programs of our own user account whose parent program is gone and that point into Local Verify's own test folders, plus whatever runs under them. In the shared temporary folders, which another agent's tests on the same machine might be using, it only touches programs older than six hours, which no real test run lasts.

## What already existed and is reused

- The health reading every machine already shares with the others every few seconds. It now carries the swap numbers.
- The existing rule that skips a peer machine that is too busy or too small. Memory pressure is one more reason to skip.
- The existing "busy, try later" answer a helper machine gives. Nothing new is invented for the refusal.
- The existing attention-item notices. The memory notice is one more kind.

## Safeguards

- The cleanup never touches another user's programs, the server itself or anything that started it, or anything outside the test folders. A program that still has its parent (one of our own conversations, or a developer running a test by hand) is never touched, even if it mentions a test folder.
- A test that starts while the cleanup is looking is never touched: anything newer than the moment the cleanup started is left alone.
- A machine is never stopped mid-test. Running tests finish; only new ones wait.
- Older machines that do not send swap numbers yet are judged exactly as before.

## What you need to decide

Nothing. This changes no constitution text. The Echo-only 5-minute M5 check from this afternoon keeps running alongside it until this is installed everywhere, and then can be retired.
