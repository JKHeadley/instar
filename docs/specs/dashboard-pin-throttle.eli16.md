# Dashboard PIN throttle: the plain version

**What this is.** You unlock the dashboard with a 6-digit PIN. That unlock page is reachable over your agent's public web address, so anyone who finds the address can try PINs. This change fixes two problems with how those attempts are limited, found by the new security program.

**The two problems.**
1. **A stranger can lock you out.** Today every attempt coming through the tunnel looks like it comes from the same place (the tunnel software, running locally), so your tries and a stranger's tries share one limit. A stranger sending a few wrong PINs uses up the limit, and then *you* can't unlock. That's a denial of service against the owner.
2. **The guess budget is weak.** There's one overall cap on attempts, shared by everyone, with no growing delay for a persistent guesser, no heads-up to you, and not strong enough to actually stop a determined attacker guessing a 6-digit PIN.

**What changes — the idea in one line:** let the browsers *you* use walk straight in, and put a hard wall in front of everyone else.

- **A browser you've unlocked before always gets in.** The first time you unlock, the agent gives that browser a little signed token (a cookie). After that, that browser is recognized and let straight through to the PIN — instantly, every time, even while an attack is happening. The cookie is signed so it can't be faked, only works on your agent, expires, and is useless without the PIN. If a cookie were ever stolen and used to guess, it loses its special treatment and gets slowed down like anyone else.
- **Unknown browsers share a hard cap.** All the wrong guesses from browsers the agent doesn't recognize draw down one shared budget. Once that budget is used up, more guesses from unknown browsers are refused for a few minutes. Switching to new addresses doesn't help the attacker — the budget is shared, so a whole botnet can only guess so many times before the wall comes down. (There are also growing delays for any single hammering source, and a limit per network block.)

**The honest trade — stated plainly.** There's exactly one case where *you* might be stopped for a few minutes: you reach for a **brand-new browser you've never unlocked before**, at the exact moment a big attack has the unknown-browser cap maxed out. Then that new browser is refused too. But you are never actually locked out: unlock from a browser you've used before, or straight from the machine — the local dashboard or the paired phone app, which don't go through that cap at all. And you'll get a plain-words alert that says an attack is under way and exactly how to get in. This is the deliberate choice: a never-before-used browser waits a few minutes during an attack, in exchange for a wall that actually stops a botnet guessing your PIN.

**What stays the same for you.** In normal life, nothing changes. Unlocking with the right PIN from any browser you've used before is exactly as fast as today. No new step. The only new things you'd ever see are during an actual attack: the one plain-words alert, and — only on a never-used browser at that moment — the few-minute wait with its recovery path.

**The true-client fix.** Underneath, the limit is now keyed to each visitor's real address, read from a header the agent trusts only when the request genuinely came through its own tunnel software — never from a program on the machine or a direct local caller forging it. That's what stops a stranger's guesses from ever touching your limit.

**Not in this change.** A deeper hardening — handing the browser a short-lived, limited token instead of the full master key when you unlock — is the right next step but it touches how the whole dashboard talks to the agent (dozens of places, plus the live-updating streams), so it needs its own careful change with a full dashboard test. It's written down as a tracked follow-up (SEC-002b), not rushed in here.

**What a reader needs to decide.** Whether this ships on for every agent next release. The spec says yes: it removes a live way for a stranger to lock the owner out, it actually stops distributed guessing, and in normal use the owner notices nothing.

<!-- verify-fix 2026-11-15: the spec maturation-plan ladder line format was corrected (feature-ladders-coverage); this plain-language overview is unchanged. -->
