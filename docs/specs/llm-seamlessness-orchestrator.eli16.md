# LLM Seamlessness Orchestrator — ELI16 Overview

## What's the problem?

When an agent runs on multiple machines, it has to make smart decisions about **where work should happen** and **when to move things around**. Right now, those decisions are purely mechanical:
- "This machine is 10% loaded, that one is 20%, so move the conversation to the less-loaded machine."
- "This file was last touched 2 hours ago, so maybe I should fetch it before the user needs it."

But mechanical rules break down. A conversation might *seem* like it should move, but actually the user is actively typing. A file might *seem* worth fetching, but the network is slow right now. The agent acts dumb because it has no real intelligence backing these decisions.

## What does this fix?

This spec adds a **background LLM brain** that wakes up every 5 minutes and thinks about the agent's situation. It reads:
- "Which conversations are running and where?"
- "What machines are online and how loaded are they?"
- "What projects is the agent working with and where do they live?"

Then it **proposes** smart moves:
- "Move this conversation to the Mini because both the user and the project live there now."
- "Pre-fetch this project to the Laptop because the user is about to work from the Laptop."
- "Suggest the user continue on Machine A because there's less churn happening there."

The key insight: the agent's brain (LLM) is way smarter about these decisions than a formula. It understands *context*.

## How does it work?

A background job runs every 5 minutes (configurable). It's tier-1 supervised, which means it's **not expensive** — just a Haiku call to think through the situation. It proposes up to 3 moves.

Most proposals are "safe" — like "pre-fetch this file in the background." Some need confirmation — like "move your conversation to a different machine."

All proposals are **logged and visible** so you know what it's thinking.

## What does the user experience?

**Before:** The agent moves your conversation randomly or pre-loads files at weird times. It feels reactive and dumb.

**After:** Files you need are *already there* before you ask. Conversations move to the *right* machine at the *right* time based on what you're actually doing. The agent feels *smart* and *proactive*.

Example:
- You're working on a spec on your Laptop.
- The orchestrator notices: "User's been on Laptop all day, and the spec they're editing lives there. But they also have an open conversation on Mini that's idle. Suggest moving the conversation to Laptop to consolidate."
- Without you asking, your work is consolidated where you're actually working.

## Why does this matter?

Goal B is "one coherent agent across many machines." But coherence doesn't just happen — it requires intelligence. Right now, the agent is reactive ("oh, you need this file? let me fetch it NOW"). With the orchestrator, the agent is **proactive** ("I noticed you're doing X, so I got Y ready for you in advance").

That's the difference between a tool and an assistant.
