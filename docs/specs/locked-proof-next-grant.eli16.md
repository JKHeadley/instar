# Locked-Mac proof: confirm the next session actually opened

One locked-screen test checks what happens when an old, suspended guard is resumed while a new remote-desktop session is open. The guard is the small helper responsible for locking the Mac again after a remote session ends. This test is meant to show that a guard from an earlier session cannot interfere with the next one.

The test driver previously tried to open the next session, waited for its controls, and ignored a timeout. It then announced that the next session was open even if the controls were still hidden. The final verdict checked that the Mac ended locked and the old guard was gone, but did not require evidence that the next session had opened. A failed setup could therefore look like a successful safety test.

The driver now stops the case if the next session times out or its controls are hidden. It announces the next session only after seeing its controls. The verdict also checks the recorded result, so old or incomplete evidence cannot pass this requirement merely because the Mac ended locked. The normal recovery still runs after a failed setup.

This changes the test harness only. It does not enable locked-screen access, alter the desktop helper, or change macOS permissions. Tests cover successful opening, timeout, hidden controls, missing evidence, and recovery after failure. Passing these software tests does not substitute for running the case on the dedicated proof Mac. Reverting this change restores the previous test behavior without any migration.
