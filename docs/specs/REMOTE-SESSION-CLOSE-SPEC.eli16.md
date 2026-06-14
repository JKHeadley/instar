# The close button for other machines' sessions — the plan, in plain English

> **Status:** Approved by Justin (topic 13481) on 2026-06-12 — queued to build after the guard-posture endpoint ships.

## What this is

The missing half of your "one dashboard" ask. You can already click any machine's session and stream its terminal to wherever you are; this adds the close button (×) to those remote sessions too, so closing a Mac Mini session from your laptop works exactly like closing a laptop one.

## Why it's needed (what actually happened)

You asked it yourself: "Why can't I close out a mac mini session from the dashboard like I can the laptop sessions?" The honest answer was that it was never built — the close button only knew how to close sessions on the machine you're looking at, so remote sessions deliberately hid the button rather than show one that wouldn't work. When five stale Mini sessions needed closing this week, it took hand-typed commands instead of five clicks.

## How it works, simply

When you click × on a remote session, your laptop's server passes the request to the machine that owns the session — over the same secured, authenticated connection the machines already use to share session lists — and THAT machine does the actual close, by the session's unique id (so it can never hit the wrong session that happens to share a name). Your laptop is a courier; the owning machine does the work.

## An honest correction the review forced

A first draft of this said the owning machine's safety guards would "refuse" to close a protected session. That was wrong, and the review caught it: a close YOU click (as the operator) deliberately overrides those guards — exactly like the local × already does. The guards exist to stop the system's own automatic cleanup from killing something important, not to stop you. So this design is honest about it: closing a protected session from another machine WILL close it, and the safeguard is that the dashboard tells you it's protected and which machine it's on, and asks you to confirm — informed consent at the click, not a refusal that doesn't actually exist.

## The safeguards, in plain terms

- **Same power as the local button, just longer reach.** It doesn't invent a stronger kill — it's the same operator close you already have, now reaching another machine. Because the reach is wider, the design adds real containment around it (below).
- **A wrong-machine kill is impossible by construction.** It targets the session's unique id and routes only through your machines' verified address book — never an address built from the request — and a stale or moved tile shows a calm "already closed, refreshing," never a kill aimed at the wrong place.
- **Credentials never leak to a bad address.** Before your machines' shared key is attached to any cross-machine request, the address is checked against an allowlist — a recycled or tampered address is rejected, not trusted.
- **Rate-limited and double-logged.** The feature can't be looped into a mass-kill; and BOTH ends keep a record — the owning machine logs the close, your machine logs the order — so nothing disappears without a trace at either end.
- **Honest about uncertainty.** Offline machine → "unreachable" in seconds; a slow machine that might have closed it anyway → "outcome unknown, refreshing" (never a fake "nothing happened"); a session already gone → a calm note, not a scary error.
- **Always a human (or your explicit agent) at the trigger, behind the PIN.** Nothing closes anything on its own. Completely separate from remote typing, which stays off by default.

## What you need to decide

Whether to approve building this. Small build (one relay route + showing the existing button on remote tiles + tests), and it completes the dashboard story: see everything, stream everything, manage everything — from one place.
