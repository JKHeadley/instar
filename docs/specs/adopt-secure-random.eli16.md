# ELI16 — Unpredictable secrets, everywhere they're minted

When the system invents a secret — the 6-digit PIN that guards your dashboard,
or an internal access token — the number must be impossible to guess. The code
was using the general-purpose random function, which is fine for shuffling a
playlist but predictable enough that someone observing outputs could narrow
down the next one. An outside contributor fixed five of the six places this
happened; our contribution process couldn't accept the PR directly (it can't
carry our internal review records), so we adopted it with the author's name
preserved on the work, and fixed the sixth place their sweep missed. Nothing
about the PINs or tokens changes shape — same six digits, same token length —
they're just actually unpredictable now. Existing credentials are untouched.
