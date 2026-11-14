# An agent's own stop is the agent's to release

## The problem in plain terms

Instar has a background watcher that merges an agent's finished pull requests once they pass their checks. It has a kill switch, and anyone can pull it. Turning the watcher back on needs the operator's dashboard PIN.

On 3 November one of my autonomous sessions pulled that stop for a good reason: the old watcher had merged a PR too early. The fix went in shortly afterwards. That session had ended, though, so nothing turned the watcher back on, and only Justin's PIN could. He ended up owning a chore caused by a stop he never pulled.

## What already exists

Each stop gets its own unique id, so releasing one can never undo another. The stop route is open to any caller. The dashboard and agent sessions use the same login token, so the server cannot tell them apart by credential.

## What is new

**Stops now have two classes.** A stop is operator-class unless the caller explicitly claims it as the agent's own. The dashboard never makes that claim, so a dashboard stop always needs the PIN. All existing stops have no claim and stay PIN-only, including the one active today.

**An agent stop must say what will end it.** It records the owning topic and the full reason, and gets a marker back. The fix PR cites that marker in its description, since a stop is usually pulled before any fix exists. The stop releases only when GitHub shows such a PR merged after the stop, and the release tag of the version this server is actually running contains it. A merged but uninstalled fix does not count.

**There is a new release route.** It takes one stop id at a time. It reads the stop's class from storage and checks the condition itself, so what a session says cannot change the answer. If it cannot read GitHub, it refuses.

**A stop can't be orphaned.** Every open agent stop has a tracked commitment. A pass every 10 minutes checks each stop's condition. When it is met, or when the stop has stood for 6 hours without it, the pass wakes a session on the owning topic to finish the job. One Attention item tells the operator the stop exists, so they can see it and pull their own if they disagree. Plain stops get one notice too, because nothing told anyone before.

## The safeguards

- Stopping gets no harder. A bad claim still stops; it just becomes PIN-only.
- No agent can release or downgrade an operator's stop.
- The PIN still clears any stop.
- Nothing releases by itself. A session has to act, and its name and note go on the record.

## Known limits

The server cannot see who asked for a stop. If Justin says "stop" and a session wrongly labels that as its own, it could release it later, once a PR citing it is running. The Attention item labels it as an agent stop, and a stop he pulls himself stays out of reach. A session could also cite the marker on a PR that does not really fix the cause; the release names the PR it relied on.

## What the reader needs to decide

Nothing. This needs no constitution change and touches no owner-protected file. The stop that is active today stays as it is and still needs the PIN once. To back out, revert the PR: any agent stops then become PIN-only, the stricter side.
