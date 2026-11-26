# Locked-Mac proof: make "just before Enter" tests really land before Enter — ELI16

## What this is

The locked-Mac proof is a test script that drives a real test Mac through 30 crash and timing cases for remote desktop through the lock screen. Three of them (15.1, 15.5, 15.7) are supposed to interrupt a session a split second before the password's Enter key is pressed: Stop pressed, the connection dropped, or the server killed. Their twins (15.2, 15.6, 15.8) do the same just after Enter.

## What went wrong

The script guessed when Enter would come by counting from when the remote session opened, then checked the clock only every quarter second. Measured on real runs, the interruption actually landed between 15 and 890 thousandths of a second after Enter. So the "before Enter" tests were really repeating their "after Enter" twins. They still passed, because the verdict only looked at how the Mac ended up (locked), not at which side of Enter the interruption landed. The safety claim "an interruption right before Enter is handled" was therefore not shown by any run. Separately, a run started in a fresh results folder carried on without its timing calibration file, so these cases quietly tested something else.

## What changes

- The script now aims from the moment the password duty is created on the Mac. That is a steady, measured time before Enter, recorded by the calibration step as a new number. It then sleeps to that exact point instead of waiting for the next quarter-second check, starting about three characters before Enter. While waiting for the duty to appear, it checks every 50 thousandths of a second rather than every 250.
- Every run records how far before or after Enter the interruption started. A "before Enter" case whose interruption started after Enter now fails, with the gap stated. The deadline case compares the grant's own end time with Enter in the same way.
- A run refuses to start these cases when the results folder has no calibration, or an old calibration without the new number, and says which cases need it.

## Safeguards

This changes only the test scripts, never the product. The new behaviour is unit-tested with a simulated Mac: the interruption fires exactly 170 thousandths of a second before the simulated Enter, a late interruption fails with its measured gap, and the refusal names the cases.

## What the reader needs to decide

Nothing. Revert undoes it. The next proof run needs one fresh calibration first.
