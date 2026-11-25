# Keep two workers from starting the same round

An ordinary round and a managed continuation worker can point at the same project task. In the test setup, they now use the same project lock when they start. A managed worker saves its claim before releasing the lock. An ordinary worker checks for that claim before launching, including when an edited round is about to start again.

This change is an intermediate step toward production enablement. The tests check both directions. An ordinary round holding the lock prevents a managed reservation, and a saved managed reservation prevents the ordinary round from starting. A worker can outlive its server, so restart recovery still needs to confirm what happened to the old worker before starting a replacement. The production switch remains off while that work is open.
