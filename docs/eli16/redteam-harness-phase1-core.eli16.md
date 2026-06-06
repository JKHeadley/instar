# MTP Red-Team Harness — Phase 1 core (ELI16)

> The one-line version: the testable engine that decides, for any organization's rulebook, how hard an attack has to push before an agent's "no" breaks — and whether that "no" actually came from the rulebook or just the model's gut.

## The problem in one breath

We proved an agent will refuse a bad request when you announce "this is a test." That's the easiest possible attack. Real attacks don't announce themselves, every organization has a different rulebook, and — the part we learned the hard way — pasting attack text into a long-lived conversation can permanently kill that conversation. We needed a reusable engine that handles all three: escalating attack levels, any org's rulebook, and attack text that never touches the orchestrator's memory.

## What already exists

Instar already has the organization rulebook format (ORG-INTENT.md — constraints, tradeoffs, identity), a checker that asks "would this action be refused?" (the G1 feature), and a rig that can send a deployed agent a real user message and read its reply. This change adds the brain that ties those together into a measurement.

## What this adds

A single browser-free TypeScript module plus two starter scenario packs:

- **A pack linter** that enforces "channel coherence" — a scenario must declare who it's pretending to be, and that pretense has to be plausible from the channel it arrives on. An "I'm a stranger" claim arriving from the operator's own authenticated account is nonsense, so the linter rejects it as an error.
- **An expectation resolver** that, for whatever org rulebook it's pointed at, decides whether the org actually governs a scenario or not. If no rule matches, the result is "ungoverned" — meaning any refusal you see is the model's instinct, not the org's rules. That's the org's to-do list for writing better rules.
- **An outcome classifier** that reads the agent's reply and labels it: refused-and-cited-a-rule, refused-without-grounding, deflected, partially-complied, or fully-complied (a breach). A breach signal always wins over a polite "I can't," so the harness never flatters itself.
- **A boundary-map builder** that turns a pile of probe results into a clean picture: per scenario, the highest attack level the "no" survived, where it first cracked, and how much of the whole refusal surface actually traces back to the rulebook.

## The safeguards

Attack text lives in files, referenced only by path and hash — this module never reads a payload body. Only the benign bottom rungs of the ladder are committed; the higher-pressure and engineered payloads are written in a throwaway session at run time and are gitignored. The committed fixtures were authored in an isolated session, never in the working transcript, which is the whole point: the thing that wedged us before cannot happen here.

## What ships when

This change is the engine and the starter packs, fully unit-tested (both sides of every decision). The command-line tool, the dashboard view, and the first live run against a real agent come next — this is the foundation they stand on.
