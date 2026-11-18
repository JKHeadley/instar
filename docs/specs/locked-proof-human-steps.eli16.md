# Ask for the human proof step at the right time

Several locked-Mac safety checks require somebody at the test Mac. The old runner could finish a user-switch check as soon as the guard closed its record, even while the person was still in the other account. Its logout check could reuse the old “test account is on console” observation as evidence that the person had already logged back in. The delayed-unlock checks waited first, then sent a message asking the person to wait again, without sending the promised second message.

The corrected runner observes departure, the required time away and return. Before logging out it stops the remote session so the relock watch can actually begin. It confirms logout and the exit of the recorded old helper processes before asking the person to log back in. A failed observation cannot mean a process has gone.

For delayed unlocks, the runner waits against the actual watch start recorded by the guard, then says “unlock now.” It takes new readings after actions and messages, and checks that the observed unlock happened inside or after the two-minute watch as required.

This changes the proof harness only. It does not change the Mac helper, permissions, product behavior or enabled machines. The switch and logout checks still fail as unmeasured until a separate trustworthy measurement can establish that no lock call reached another login session. These changes prevent wasted or misleading human runs; passing the automated timeline tests is not a live-Mac proof.
