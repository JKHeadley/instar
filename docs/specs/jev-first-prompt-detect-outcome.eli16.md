# Prompt-detect outcome label: the plain version

## What this is

PromptGate watches agent sessions in their terminals. When a session goes quiet, it asks a model: "Is this session stuck at a system prompt waiting for a key press?" Since 14 November, Jev (a much cheaper model) is asked the same question in the background, and both answers are written down. But nothing ever wrote down what the terminal did next, so there was no way to say which answer was right. Every grade was zero.

This change adds that missing piece: a small watcher that looks at what the pane does in the 15 minutes after each check, and records one outcome for it. It also fixes a confusing name.

## What already exists

- The decision-quality system: every model decision gets an id when it is made, and later "outcome" rows can be attached to that id with a grade (right, wrong or unknown) and a named rule saying how strong the evidence is.
- The Jev shadow row for every prompt check, and the normal model's row, both in the local provenance log.

## What is new

1. The Jev row now carries the id of the normal model's call and the session name, so the Jev row, the normal row and the outcome all join on one id. No new id is invented.
2. A watcher remembers, per session, what the bottom five lines of the pane looked like when the check ran. Then exactly one of these is recorded:
   - The bottom changed and nobody typed anything: the pane was not stuck. This is the only case that grades the answer (a "no prompt" answer is right; a "stuck" answer is wrong).
   - Something was typed while the bottom had not changed: a hint it was stuck, not proof. Recorded as unknown.
   - Nothing changed and nothing was typed within 15 minutes, the session ended, or the watcher lost track: unknown.
   "Typed" means any key or text Instar writes into the session, caught at the one place every write passes through.
3. The detector used to be recorded as `prompt-injection-detect`, which sounds like the security check for prompt injection. New rows say `terminal-prompt-detect`. Old rows stay where they are and the quality page counts them under the new name, so no history is lost.

## Safeguards

- Watching only. It never types, never blocks, and never changes what PromptGate does.
- It only runs while the Jev prompt check is switched on (on for development agents, off on the fleet), so other agents record nothing new.
- At most 64 sessions are watched at once; the oldest is dropped with an "observer lost" outcome.
- Outcomes hold ids, labels and numbers only, never terminal text.
- A missing outcome counts as unknown, never as a pass.

## What you need to decide

Nothing. This only makes grading possible. Whether Jev may ever answer instead of the normal model is a later decision, made from these graded rows.
