# Work queue adapters — plain-English overview

This increment makes the work queue real on the development agent. It reads the
existing commitments, evolution actions, feedback clusters, and topic goals
through their normal managers, turns them into ranked work items, and connects
that registry to the running server. The queue is still read-only: it does not
change any source record or start work. A copied, isolated development install
was restarted on port 4056 and `GET /work-queue` returned HTTP 200 with real
backlog items such as “Check Codey Mini Serve Proof 2 session”.

What already existed was the registry shape and deterministic scoring rules,
but its four readers returned empty arrays and the server did not hand the
registry to its routes. That meant the code could merge while the feature stayed
dark. This increment closes that gap without inventing a second persistence
format: each adapter asks the manager that already owns its data. Commitments
come from the active commitment tracker, evolution work comes from the action
queue, feedback comes from the canonical feedback processor, and topic work
comes from the topic-intent activity index. The server receives the registry
after its broad bootstrap and before publishing its server reference, so both
queue endpoints see the same live object.

The operator-visible decision is deliberately small. Development agents can
inspect a ranked snapshot; fleet agents remain behind the existing dark gate.
Rescoring is pure computation, and an empty source remains harmless. The proof
uses copied state only to avoid touching the live service: it demonstrates that
the built code can start independently, authenticate, read real backlog state,
and return JSON over HTTP. No source record is changed by the proof request.
