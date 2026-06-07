# SubscriptionPool Registry (P1.1) — Plain-English Overview

> The one-line version: the first piece of multi-account subscription management — a registry that remembers each of your subscription accounts by nickname and *where it logs in*, never its tokens.

## The problem in one breath

Justin runs 5–6 Claude subscriptions but instar only ever uses one at a time, and swapping between them means the full browser login ritual every time. The goal (this project) is to pool all the accounts, track each one's quota, and auto-swap before any hits its limit — with phone-friendly login. This change builds the foundation: the place that remembers which accounts exist.

## What already exists

- **Claude Code per-account config homes** — Claude Code already supports pointing each login at its own config directory, so multiple accounts can coexist on one machine. Instar wasn't using this yet.
- **The live quota endpoint** — each account's 5-hour and weekly usage + reset dates are readable. (Used by a later phase, not this one.)
- **Durable registry pattern** — instar already has file-backed registries with atomic writes and single-writer versioning (e.g. the commitment tracker). This reuses that shape.

## What this adds

A registry — `SubscriptionPool` — that stores one entry per subscription account. Each entry has a nickname (like a machine nickname), which provider and framework it's for, its lifecycle status, and — the load-bearing part — only the **location** of its login (its config home), never the actual access/refresh tokens. A full CRUD API (`GET/POST/PATCH/DELETE /subscription-pool`) lets accounts be listed, added, renamed, re-statused, and removed.

## The new pieces

- **SubscriptionPool** — a file-backed JSON registry (atomic writes, per-record version counter). It can add/list/update/remove accounts. It is **not** allowed to store credentials: any attempt to save a field that looks like a token/secret/password is rejected outright. That's what makes "store the location, not the secret" a structural guarantee rather than a good intention — and it's what keeps us clear of Anthropic's enforced rule against putting Claude tokens into non-Claude-Code tools.

## The safeguards

- **Ships dark.** An empty pool is a pure no-op — no background work, no behavior change. Agents with one account are completely unaffected.
- **Agent-invisible for now (maturity honesty).** The route is classified internal: it does not appear in `/capabilities` and there's no "I can do this" line in the agent template yet. A bare registry with no enrollment wizard or auto-swap scheduler isn't a finished capability to advertise; it graduates when those land (P1.3 / P2.1).
- **No migration footprint.** No config/hook/skill/template changes — the route ships with the code on update.
- **Tested both ways.** 27 tests across unit, integration (real HTTP), and e2e feature-alive — including both sides of every validation boundary, the never-store-tokens guard, and corruption resilience.

## Decisions baked in (from Justin, topic 20905)

Quota-read = hybrid (C); cross-machine = re-enroll per machine now but architected so sync is a clean later add (1A→B); mid-session account swap will carry a hard session-continuity guarantee (lands in the P1.3 scheduler); Claude-first; warm only the accounts likely to be picked next.
