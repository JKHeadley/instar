# Routing Map surface — Plain-English Overview

> The one-line version: a new read-only dashboard page (and the API behind it) that shows, for every internal AI job the agent runs, which "door" and model it uses and its full ordered fallback list — a map you can read, that changes nothing.

## The problem in one breath

Instar routes its background AI work (sentinels, gates, summarizers) across several "doors" — Claude Code, Codex, Gemini, and some paid API doors — each with an ordered fallback list. That routing map already exists in code as static data, but there was no way to actually SEE it: an operator diagnosing an unexpected route had to piece it together from source files and live config. This adds a single readable surface for "which door + model does each job-kind use, and what does it fall back to?"

## What already exists

- **The four routing lanes ("chains")** — `FAST`, `SORT`, `JUDGE`, `WRITE`, each an ordered list of `{door, model}` positions with flags (money-gated, injection-safe, metered). Pure static data in `src/data/llmBenchCoverage.ts`.
- **The job-kind → lane registry** — a map from each internal component (MessagingToneGate, PresenceProxy, …) to its nature + lane.
- **The label → concrete-model-id registry** — resolves a benchmark label like `gpt-5.5` to the real model id.
- **The legacy route `GET /intelligence/routing`** — already shows the live "which framework does each component use" view (a different, narrower question). We do NOT touch it.
- **The `LLM Activity` dashboard tab** — the existing pattern for a read-only observability tab. We mirror it exactly.

## What this adds

One new read-only API route and one new read-only dashboard tab. The route (`GET /intelligence/routing/chains`) composes the existing static maps into a single structure: every known job-kind, its lane, and its full ordered door+model fallback list, each position annotated (metered/skipped-now, money-gated, unsafe-for-untrusted-input, critical-gate). The dashboard "Routing Map" tab renders that as two clear tables. Nothing is added to the routing logic — the page only DISPLAYS the maps the router already uses.

## The new pieces

- **`buildNatureRoutingMap()`** (a new pure module, `src/core/natureRoutingMap.ts`) — reads the shipped static maps and composes the display structure. It is side-effect-free: it performs zero writes, mutates no config, and changes no routing behavior. It is NOT allowed to select a route, adjust a cap, toggle anything, or touch money/PIN surfaces — it only describes.
- **`GET /intelligence/routing/chains`** — a Bearer-auth sibling of the existing routing route. Same 503-when-no-router shape. Optional `?trace=<component>` drills into one job-kind. Pure reads.
- **The "Routing Map" dashboard tab** — a read-only page, no inputs, no buttons that change state, just a Refresh.

## The safeguards

**Prevents any behavior change.** The whole feature is a read of static data plus a live read-only annotation (each component's currently-enforced framework). It never writes, never routes, never flips a flag. The legacy route is left byte-for-byte unchanged, verified by test.

**Prevents scope creep into money/PIN territory.** This is explicitly Surface 3 (the read-only map) of a larger "control room". The write/adjust/go-live controls (Surfaces 1/2, money- and PIN-gated) are out of scope and untouched.

**Prevents a broken map from misleading.** The page states plainly that it shows the shipped map, not live actuation (nature routing is dev-gated / dry-run), and that metered doors are skipped for now — so an operator never mistakes the map for "what ran".

## What ships when

All of it in one PR: the pure module, the route, the dashboard tab, and the tests (unit for the composer, integration/alive for the route returning 200 not 503). It is dark/reversible in the sense that it adds a surface only — removing it is a straight revert with no persistent state.

## What you actually need to decide

Ship a read-only routing-map page + API that displays the existing routing map without changing any routing behavior — yes/no?
