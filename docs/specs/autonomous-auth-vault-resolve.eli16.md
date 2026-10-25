# Autonomous runs must not silently fail to start — plain-English overview

## What Changed

When you ask an agent for a long unattended work session (an "autonomous run"),
a small script sets the run up: it checks the machine has room, registers the
run with the agent's own local server, and writes the state file that keeps the
run alive. That script talked to the server using a password it read from one
fixed spot in the config file. On any agent whose secrets have been moved into
the encrypted vault, that spot no longer holds the password — it holds a
placeholder. The script sent the placeholder, the server said "no", and on
strict installs the run was created in a "preparing" state it could never leave.
Nobody was told. That is exactly how a 24-hour run on 19 September never
started.

Two fixes, both in this change:

1. **The password is now looked up properly.** If the config file holds a real
   password, use it. Otherwise read it from the encrypted vault, through the
   same hardened helper everything else uses. This applies to the setup script
   AND to the companion script that keeps a running session going — eleven
   separate places between them.
2. **Failure is loud.** If the server refuses the registration because the
   password is wrong, the script now says so in plain text. On installs where
   registration is required before a run may start, it stops right there with a
   clear error instead of quietly writing a run that will never wake up.

While testing this, we found and fixed a second silent killer that was already
there: a counting command in the "is the machine too busy?" fallback would kill
the whole setup with no output at all whenever the server was unreachable and
no other run had left files behind. Same symptom — you ask for a run, nothing
happens, nothing is said.

Existing agents get all of this automatically on their next update: the update
step recognises unmodified copies of the two scripts and replaces them; copies
an operator has customised are left alone, exactly like every previous script
update.

## What to Tell Your User

If you start a long unattended session and something is wrong with the setup,
you now get told immediately, in plain words, instead of finding out the next
morning that nothing ever ran.

## Summary of New Capabilities

- Autonomous setup and its keep-alive hook read the server password from the
  vault when the config holds only a placeholder.
- A refused registration prints a clear error, and aborts setup on installs
  that require registration before a run can arm.
- A pre-existing shell trap that could kill setup silently is fixed.
- Both fixes reach already-installed agents through the normal update path.

## What you actually need to decide

Nothing — this restores behaviour everyone already expected. The only judgment
call made: on installs that do NOT require registration, a refused registration
stays non-fatal (the run still starts, the discipline layer degrades), because
aborting there would change behaviour beyond the bug.
