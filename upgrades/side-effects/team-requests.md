# Side effects: requests to the owner

**Over-block:** one open request per person or place, so a second ask waits. Requests expire after three days, a week at most.
**Under-block:** the free-text reason is shown to the owner as someone's words. It is display data, and the action comes only from typed fields.
**Level:** the request gives nothing. Approval is the owner's existing signed write, so every existing check still applies.
**Signal vs authority:** a request is a signal. The owner's signature stays the only authority.
**Confined sessions:** gain one route, `POST /team/proposals`. The requester comes from the session, and `GET /team/people` stays refused.
**Rollback:** remove the routes and the allowlist line; stored requests are ignored.

## What the app needed
From building against the routes: redeem says the code is with the inviter, `GET /mobile/device` carries `standing`, gate refusals carry words and a failed Face ID action no longer returns exception text, and context reports record health and the MSP phones an invite will affect. All additive. `detail` beside an `error` changes nothing for a client reading only `error`.

A person asking for themselves reads "Sam asks to use X", from typed fields as before.

## Carried repair
The one line from PR 2927, so this PR passes on its own while main is broken by PR 2916 (hub 14:58): the session context file name gains a random part, since two writes in one millisecond collided.
