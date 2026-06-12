# The close button for other machines' sessions — the plan, in plain English

## What this is

The missing half of your "one dashboard" ask. You can already click any machine's session and stream its terminal to wherever you are; this adds the close button (×) to those remote sessions too, so closing a Mac Mini session from your laptop works exactly like closing a laptop one.

## Why it's needed (what actually happened)

You asked it yourself: "Why can't I close out a mac mini session from the dashboard like I can the laptop sessions?" The honest answer was that it was never built — the close button only knew how to close sessions on the machine you're looking at, so remote sessions deliberately hid the button rather than show one that wouldn't work. When five stale Mini sessions needed closing this week, it took hand-typed commands instead of five clicks.

## How it works, simply

When you click × on a remote session, your laptop's server passes the request to the machine that owns the session — over the same secured, authenticated connection the machines already use to share session lists — and THAT machine decides. All the existing safety checks live on the owning machine and stay there: a protected session refuses to close, a busy one says why, and the answer (including any refusal reason) comes back to your screen. Your laptop is a courier, never a decider.

## The safeguards, in plain terms

- **No new powers.** The owning machine already has this close door, already locked correctly. This just lets your dashboard knock on it from afar. Every refusal rule that protects sessions today protects them identically.
- **Always a human (or an explicit request) at the trigger.** The button lives behind your dashboard PIN; nothing closes anything on its own.
- **A paper trail.** The owning machine's session log records every close with a note that it came from the remote dashboard — no session ever disappears without a trace.
- **Honest failures.** If the other machine is offline you get "unreachable" within seconds; if it refuses, you see its reason — never a fake success, never a silent nothing.
- **Completely separate from remote typing.** That stays off by default as you decided; closing a session shares none of its plumbing.

## What you need to decide

Whether to approve building this. Small build (one relay route + showing the existing button on remote tiles + tests), and it completes the dashboard story: see everything, stream everything, manage everything — from one place.
