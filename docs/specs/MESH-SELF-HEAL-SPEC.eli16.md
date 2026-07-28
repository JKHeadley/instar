# Mesh Self-Heal — Plain-English Overview

> The one-line version: when you run one agent across two machines, the machine "in charge" must actually be doing the job (fetching your messages) — and everything the agent needs must follow you across machines — so you never have to hand-fix a stuck setup.

## The problem in one breath

Your agent runs on two machines (a Mac Mini and a laptop). Exactly one is supposed to be "awake" — fetching your Telegram messages and answering. Today the laptop kept holding the "I'm in charge" badge, renewing it perfectly every few seconds, while quietly NOT fetching your messages at all. Every safety check looked at it, saw it renewing, and said "healthy — leave it alone." So your messages silently dropped, and you had to notice and tell the agent to fix it. Worse, a manual fix attempt spun up a second copy of the conversation that double-messaged you.

## What already exists

- **The lease ("in charge" badge)** — a numbered token one machine holds to be the awake server. There are already self-heal features (called F1–F4 and "soloCaptainHold") that detect a frozen badge and can hand it over.
- **Replicated stores** — some data (your preferences, contacts, learnings) already copies across machines. Secrets already sync.
- **Working-set handoff** — a machine can already pull files it's missing from the machine that made them.

## What this adds

Two principles, both straight from today's incident:

1. **Being in charge must require doing the job.** A machine that holds the badge but stops fetching your messages now drops it automatically. And a brand-new alarm watches for "nobody is fetching messages at all" — the exact silent state that hurt you — and forces a recovery.
2. **Nothing you depend on may be stuck on one machine.** Any data the agent needs is either shared by default or transparently fetched on demand from the machine that has it. You never hear "that's on the other machine." Browser logins are handled the safe way: the agent knows which machine holds which login and routes there, instead of copying your private cookies around.

## The new pieces

- **Job-liveness signal** — proof a machine is actually fetching/serving, separate from "is it renewing its badge." The badge now depends on it.
- **Nobody-polling detector** — an independent watcher that catches "no one is serving you" and recovers, with at most one honest heads-up to you.
- **Ownership-checked spawn** — a machine refuses to start a conversation another machine already owns, so two copies can never double-message you. Closing a conversation cleanly forgets it, so it can't silently come back.
- **The Machine-Independence Standard** — a registry of what's shared, one go-to channel to lazy-load what isn't, and an automatic check that stops new "stuck-on-one-machine" data from sneaking in.

## The safeguards

**Won't drop a healthy machine.** The "you stopped doing the job" timer is generous and confirmed over several checks; a machine only ever hands the badge back gently (signed), never grabs it by force from a live one — that exact over-grab caused today's duplicate, and the design forbids it.

**Won't double-message you.** Two machines serving one conversation is made structurally impossible, not cleaned up after.

**Won't turn on untested.** Nothing here goes live until it's proven on the real two-machine pair using a real Telegram login — because fake tests with perfect data gave false confidence here before.

## What ships when

Safest-first: the duplicate-prevention piece first (most visible, lowest risk), then the nobody-serving alarm, then the badge↔job binding (highest authority, verified last). The data-coherence standard rolls out alongside, with its automatic enforcement check as the keystone that keeps the seam from ever coming back.

## Build status

**G3 (duplicate-prevention) is built and shipping dark** — the lease-gated spawn ("serve only if I genuinely hold the badge, else forward") and the single-writer binding lifecycle ("a binding exists only while a live session does") are in, behind an off-by-default flag with a dry-run soak that records exactly how many duplicates it *would* have prevented (so it can earn promotion instead of rotting silent). It changes nothing until deliberately turned on and live-verified on the real two-machine pair. G2 (nobody-serving alarm) and G1 (badge↔job binding) follow.
