# Why the Remote Desktop list could not check another machine — Plain-English Overview

## The problem in one breath

When you open Remote Desktop, the front machine (the Mac Studio) asks every other machine whether its screen can be opened. If one does not answer properly within 3 seconds, the list says "Could not check this machine's desktop. Select Check again to retry." On 27 Nov the Mama PC showed that line every time, while the Mama PC itself said its desktop was ready.

## Why it was hard to find

The front threw away the reason. It did not log whether the other machine refused the signed request, answered with an error, was too slow, or could not be reached. So the person saw a dead end, and the agent had nothing to look at.

## What this changes

When a check fails, the front now writes one line to its own server log. The line names the machine, gives a fixed word for why (for example "timeout", "unreachable", "connect", or "http-401"), and says how many milliseconds it took. The raw error text is never written, because it can hold private paths. What the person sees in the list is unchanged.

The same sentence has a second source. The other machine can answer on time but say that its own desktop check failed, for example because its screen helper did not reply. That case was silent on both machines. Now the other machine names its failure with a fixed word in its reply (for example "timeout" or "windows-desktop-companion-refused") and writes the same line to its own log. The front logs that word next to the machine's id. The word never reaches the screen, and anything that is not a short fixed word is dropped.

## What you actually need to decide

Nothing. The next time the Mama PC shows that line, the Studio's log will say why, whether the failure was on the way to the Mama PC or inside it, and that reason decides the next fix.
