# Accept all saves stop repeating the same slow checks (plain-English overview)

**What happened.** Justin pressed "Continue accepting projects" on the Suggested groups page. It worked on two projects for about 15 seconds each. Then it said "Stopped at 2 of 20: your agent is not answering right now", with nothing accepted. The fix from the day before had worked: the Studio no longer turned away the M5's repeated messages. But something else was making each save wait too long.

**Why.** The Studio's shared conversation history has one "owner step" that does its jobs strictly one at a time. Every save goes through it. When the other machine is slow to answer, the history is marked "not ready". Then three slow things happen inside that step: it asks the other machines where they are, it re-checks readiness, and it re-reads and re-checks every saved record on disk. A background job already does all three every 10 seconds. A save waited for that background job to finish, then did all three again itself. On a busy Studio that took longer than the page's 20 seconds, so the page decided the agent was not answering.

**What changes.**
- The disk check remembers its last result. If nothing has been saved, erased or dropped since then, it reuses that result instead of re-reading every record. Any change, however small, makes it read everything again.
- A save no longer re-asks the other machines and re-checks readiness when the background job did exactly that less than 10 seconds ago. The background job itself still does it every time.
- When any of these steps takes more than 2 seconds, the log now names the step and how long it took, so the next slow moment can be measured instead of guessed.

**What stays the same.** Every safety check a save must pass before it is recorded. Who may save (owner only). How the machines confirm a change. When the other machine is truly unreachable, the page still says plainly that changes are not being confirmed.

**What you need to decide.** Nothing new. It is a small, reversible change (Tier 1); undoing it is a plain revert. After it is installed, Chief of Staff runs Accept all again with Justin.
