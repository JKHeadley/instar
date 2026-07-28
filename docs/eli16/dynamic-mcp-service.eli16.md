# Dynamic MCP — the composition service (ELI16 overview)

## What this is

This is the piece that snaps all the dynamic-MCP parts together into one thing the
rest of the app can call. On its own, each earlier part does one job: decide a list,
record a list, mint an approval code, carry out a change. This service holds them
together and exposes three simple actions: "tell me what tools this session has,"
"load a tool," and "drop a tool."

It deliberately does NOT reach into the machine itself. The risky, host-specific
operations — actually restarting a session, finding/cleaning up a browser process,
checking whether a session is preapproved or mid-task — are all handed in from
outside. That keeps this service testable end-to-end with stand-ins, and it means
the one place that talks to the live machine (the server wiring) stays small.

## What you can do with it

- **Ask the state:** "topic 5 is running with [threadline], and it's preapproved."
- **Load a tool:** if preapproved, it records the new list, restarts, and confirms.
  If not preapproved, it hands back a one-time approval code and changes nothing
  until the operator's genuine yes comes back carrying that code.
- **Drop a tool:** same approval rules, plus it refuses if the session might be
  mid-task, and it cleans up the dropped tool's leftover process after the restart.

## Why it's safe

It's pure assembly over injected helpers — it starts nothing and kills nothing by
itself. Seven tests drive the real flow against a real temporary project folder:
reading the lean default, a full load, the approval-code round trip (including a
forged code being rejected), a drop that cleans up the leftover process, a drop that
safely aborts when the session might be busy, and a failed restart that rolls back
cleanly. It's still not connected to the live server — that final wiring (the API
endpoints) comes next, and the whole feature stays off by default until then.
