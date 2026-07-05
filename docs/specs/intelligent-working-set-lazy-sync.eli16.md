# Intelligent Working-Set Lazy-Sync — ELI16 Overview

## What's the problem?

When I run across two machines (an always-on Mac Mini and a Laptop that comes and goes) and a conversation moves from one to the other, the **files I produced during that conversation** — a report, an analysis, a summary I wrote for you — don't come with it. On the new machine I can't see them, and I don't even know they exist somewhere else. So you hear "that's on the other machine." That's not seamless.

There's already an engine that moves such files between machines — but it only "sees" files produced by a scheduled/autonomous job. A file I write **interactively** (just chatting with you, no job running) is invisible to it. Closing that one gap is what this spec does.

## What it does (and, honestly, what it deliberately does NOT)

**Does:** when I write an artifact into my own working area (`.instar/…` — reports, analyses, notes I generate for a conversation), I record it, and when the conversation moves machines that file follows automatically and I'm reminded at startup that it exists. It reuses the existing, already-hardened transfer engine (chunked, integrity-checked, never overwrites your local copy, refuses anything that looks like a secret, and doesn't block the move if the other machine is asleep — it just catches up later).

**Deliberately does NOT (yet):** sync your actual **project source files** (the `docs/`, `src/`, `tests/` in a git repo). That sounds tempting, but doing it safely would mean widening a security boundary to your whole repo and fighting git (which is *already* how project files sync between machines). So that bigger version is called out as a **separate decision for you to make** — with its own security review — not something I quietly turned on. This spec ships the safe, useful slice now.

## How it works, briefly

Each file I produce gets one durable record (which file, which machine made it, a fingerprint). Those records replicate between machines over the same trusted channel my other shared memory uses. If the same file was changed on both machines while they were apart, I keep **both** versions and flag it for you rather than silently picking one. A deleted file stays deleted (it doesn't resurrect). Everything I show you at startup is clearly "here's what may exist where, as of last sync" — advisory, and I re-check the real disk before acting.

## Why it went through six-plus review passes

The first draft confidently described the existing engine — and got it **wrong** (wrong size limits, wrong storage location, wrong security boundary). Independent reviewers who actually read the code caught it, and one deep issue: my records carry a file *path*, but the sharing layer is built to *reject* paths (a safety feature). The fix was to store an unreadable fingerprint as the identity and validate the path strictly on arrival. The lesson: verify what the code actually does before building on it.

## What it means for you

A report I wrote for you 20 minutes ago on one machine is there, and known to me, when the conversation continues on the other — without you asking. Your git-tracked project files keep syncing through git as they always have. And the tempting-but-risky "sync everything" option is a decision I put in front of you rather than making for you.
