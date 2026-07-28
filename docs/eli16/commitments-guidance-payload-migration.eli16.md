# Commitments guidance payload migration - ELI16

## The short version

Agents had a written instruction for how to record a promise, but some already-installed copies had an old command that the server rejects. New installs had the right command. Existing installs needed an update migration so they get the same fix.

## What was broken

The commitments system is the durable "write it down so I actually follow through" mechanism. It is used when an agent says something like "I will report back when the build is green." The server requires three fields when opening one of those records:

- `type`
- `userRequest`
- `agentResponse`

The stale installed instruction only sent `userRequest` and `type`. It also used `type:"follow-up"`, but the server only accepts `config-change`, `behavioral`, or `one-time-action`.

So an agent could do exactly what its local instructions said and get a 400 response. The dangerous part is not the 400 by itself. The dangerous part is that the promise was never recorded, which means the safety system built to prevent forgotten promises did not get a chance to work.

## What changed

The fresh template was already correct, so this does not change the API and does not change the new-agent template. It adds a small migration for agents that already have the `Commitments & Follow-Through` section installed.

When the post-update migrator sees exactly the stale payload:

```text
-d '{"userRequest":"<what you promised>","type":"follow-up","topicId":TOPIC_ID}'
```

it rewrites just that payload to the accepted shape:

```text
-d '{"userRequest":"<what the user asked>","agentResponse":"<what you said you would do>","type":"one-time-action","topicId":TOPIC_ID}'
```

Already-correct docs are left alone. Custom docs that do not contain the exact stale payload are also left alone.

## Why this is safe

The migration edits documentation, not live commitment state. It does not create commitments, deliver messages, change server behavior, or loosen validation. It only updates a stale example so an agent following its own instructions can successfully call the existing route.

The test proves the important deployment case: a `CLAUDE.md` file that already contains the Commitments section, but with the old payload, gets rewritten. It also proves idempotency by running the migration twice and checking the second pass makes no change.

## How we know it works

The new migration test was run before the migration existed and failed. After the migration was added, it passed. The existing contract test also passed, confirming the shipped template and migrator source still use `agentResponse` and `one-time-action`, and do not document the rejected `follow-up` type.
