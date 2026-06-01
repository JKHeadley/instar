# Plain-English overview: show the "always update now" switch in the status readout

## What Changed

The agent has a status readout you can fetch — `GET /updates/status` — that tells
you things like what version it's on and whether a restart is being held. A
recent change added a per-agent switch called "restart immediately" (always jump
to the newest version instead of waiting). The release note for that switch said
"you can see it in `/updates/status`" — but it actually wasn't there. This change
adds the one missing line so the switch's on/off state really does show up in
that readout.

## What already exists

- The status readout already exists and already lists a dozen fields.
- The "restart immediately" switch already exists and already works — the agent
  was correctly using it. The only thing missing was that you couldn't *see* its
  value by reading the status endpoint.
- The value was already being computed internally; the status route just didn't
  copy it into the response it hands back.

## What's new

- One field added to the `/updates/status` response: `restartImmediately`
  (true/false). For almost every agent it's `false`; for the developer's own
  agent it's `true`.

## What you need to decide

Nothing. It's a read-only field. If you ever want to confirm whether an agent is
in "always update now" mode, you fetch its status and look at that field.

## How to verify it worked after deploy

`GET /updates/status` now includes a `restartImmediately` field. There's a test
that fetches the status with the switch on and off and checks the field is
present and correct both ways, so it can't silently go missing again.

## Why this matters

It's a small honesty fix: a release note claimed something was visible that
wasn't. Now the claim is true, and the switch's state is actually observable —
useful when you're checking whether an agent is configured to stay on the latest
build.
