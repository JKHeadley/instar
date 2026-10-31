# Windows sign-in repair, in plain words

When a Claude or Codex account gets signed out, Instar can sign it back in by itself. It starts the login, then a short-lived helper session opens that account's own Chrome and goes through the pages like a person would. That helper only worked on Macs.

The Mama PC is a Windows machine, and Instar runs there inside WSL (Linux inside Windows). So when an account signed out there, nothing fixed it. Today sagemind-justin is in exactly that state.

**What already exists.** There is a Windows Chrome driver, `ndrive.sh`, that drives a normal Chrome with real clicks and keystrokes. We tested it from a background session on the Mama PC and it works. The old error recorded in the commitment did not come back, so the driver is not changed.

**What is new.** Four things:

- The repair can now use the helper on WSL, if a machine is set up for it. It is off unless turned on.
- A browser profile can now record its Windows folder, such as `C:\Users\Public\...`, because the Linux path means nothing to Windows Chrome.
- The helper gets Windows instructions instead of Mac ones, and the sign-in skill gains a Windows section. Existing agents receive that section on update.
- If a profile has no Windows folder, the repair says so by name rather than failing quietly.

**Safeguards that stay the same.** Only the expected account may be signed in. CAPTCHAs and phone checks are never worked around. Passwords are piped in, never placed on a command line. The sign-in link is typed the same way, because it would otherwise be readable by other programs. Instar alone decides success: the login must complete, the email must match, and a real call must work.

**What a reader should know.** Google can still ask for a phone tap on a profile it has not seen recently. The repair then asks the operator once and waits. This change cannot remove that, because it is a real human check.

**Rollback.** Turn the setting off on that machine, or revert the change. Nothing else depends on it.
