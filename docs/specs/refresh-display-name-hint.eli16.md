# A session restart refused by name now tells you the right name, even for a dead session

## What the change is

Every agent session has two names. The short one you see in lists, such as `topic-127831`, is a display name. The real handle the system uses is the tmux name, such as `echo-topic-127831`. The restart call (`POST /sessions/refresh`) needs the tmux name.

If you gave it the display name, the server already tried to help: when a running session carried that display name, the refusal named the tmux name to use instead. But that help only looked at running sessions. If the session had died (killed by a service restart, crashed, reaped), the same call came back with "not bound to a Telegram topic (checked in-memory + disk registry)" and no hint at all.

That wording was read, on 2026-10-22 on the Mama PC, as "the topic's binding was lost from the registry". It had not been. The registry had the binding the whole time, and a restart with the tmux name would have brought the session back with its conversation. The only thing wrong was the name in the call.

The change: the hint now also covers dead sessions, as long as the topic is still bound to that dead session (which is exactly the case where restarting it by the tmux name works and resumes the saved conversation). The refusal then says, in plain words, that the name looks like a display name, which tmux name to pass, and that the session is not running but a refresh of it respawns from the saved conversation.

## What already exists

- The refusal codes and the "looks like a display name" hint for running sessions (EVO-025). Unchanged, including its wording for the running-only case.
- The dead-but-still-bound respawn path: a refresh of a dead topic session by its tmux name respawns it from the topic's saved conversation. Unchanged.
- The rule that a display name is a hint, never a silent remap, because display names are not unique and restarting the wrong session is worse than a clear refusal. Kept.

## What is new

- The hint matches sessions of any status. A tmux name with any live record counts as running. A tmux name whose records are all finished is named only if the topic still points at it, so the hinted name is one that actually works.
- A dead tmux name whose topic has since been bound to a different session is left out of the hint, because trying it would only swap one refusal for another.

## Safeguards in plain terms

- No behavior of the restart itself changes. Nothing is killed or respawned differently. Only the text of one refusal gets more precise.
- The hint is still advisory. The call is still refused, exactly as before.
- Two tests cover both sides of the new boundary: a dead session whose topic still points at it is named; a dead session whose topic moved on is not.

## What you need to decide

Nothing. This is an error-message precision fix with no setting and no new behavior.
