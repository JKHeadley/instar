---
title: "Accepts-and-ignores: three surfaces that take an argument they do not implement and answer success"
date: 2026-07-30
author: echo
machine: Mac Mini
severity: medium
status: open
kind: finding
relates:
  - "docs/findings/2026-07-30-correction-loop-cannot-promote.md"
  - "docs/findings/2026-07-30-conformance-audit-probes-a-stale-tree.md"
---

## The claim

Three surfaces on the commitments API accept an argument they do not implement, discard it, and answer with
a success-shaped response. **Rejection is safe. Silence would be safe. Plausible success is the dangerous
third option**, and all three take it.

I found each separately, hours apart, while doing unrelated work. Naming them as one class is the point —
individually each reads as a small omission; together they are a pattern in how this API answers.

## The three, each re-verified with a nonsense control

**1. `GET /commitments?status=` is accepted and discarded.**

| query | records returned |
|---|---|
| `?status=pending` | 1145 |
| `?status=withdrawn` | 1145 |
| `?status=zzznotarealstatus` | **1145** |

A **nonsense** status returns the identical full set. So the response is unfiltered regardless of what is
asked, while looking exactly like a filtered one.

**2. `GET /commitments?limit=` is never read.**

| query | records returned |
|---|---|
| `?limit=5` | 1145 |
| `?limit=50` | 1145 |
| `?limit=5000` | 1145 |

**3. `POST /commitments/:id/transition` accepts a `to` naming a lifecycle status it does not implement.**

```
POST /commitments/CMT-1131/transition  {"to":"zzznotarealstatus"}
→ {"transitioned": true, "id": "CMT-1131", "owner": "agent", "blockedOn": "external"}
```

Status afterwards: unchanged. The route transitions the **owner ⟂ blockedOn** pair — which is what it was
built for — and never inspects a lifecycle status. A caller passing one gets the owner-pair no-op, and the
no-op reports `true`. The real path is a separate `POST /commitments/:id/withdraw`.

*(Control: a snapshot of CMT-1131 taken before the probe shows it was already `owner: agent /
blockedOn: external / status: pending`, so the nonsense call mutated nothing — this was a genuine no-op, not
a partial write.)*

## What it actually cost

**Instance 1 nearly produced two false alarms in one read.** Running a check with `?status=pending` returned
withdrawn commitments alongside pending ones. A downstream filter then matched four items I had personally
withdrawn hours earlier, and I was one step from reporting both a serious regression and a
silent-withdrawal-failure bug that does not exist. What saved it was reading one record directly and finding
it correctly `withdrawn` — the list was wrong, not the store.

**Instance 3 silently failed five withdrawals.** Five stale commitments each returned `transitioned: true`
and none changed. Only a read-back caught it; without that, five monuments would have sat in the ledger
looking closed.

## Why this shape is worse than an error

A rejected argument teaches the caller the API in one round trip. An **ignored** argument returns something
plausible, so the caller builds on it — and the wrongness surfaces later, somewhere else, as a conclusion
rather than as an error. In instance 1 that meant a superset presented as a filtered set; in instance 3, a
no-op presented as a state change.

This is the same family as two other findings from the same day — a health surface reporting a status it
never computed, and an audit reporting a confident ratio from a source tree it never verified. **The common
shape: a response asserting more than the work behind it supports.**

## Direction

For each surface: **honour the argument, or reject it. Never accept and drop it.** For the transition route
specifically, a `400` naming the correct route (`use POST /commitments/:id/withdraw`) is strictly better than
either alternative — it costs the caller one read and teaches the API.

The load-bearing test in every case is the same, and it is the one currently missing: **call the surface with
an argument it does not implement and assert the response is NOT success-shaped.** A test that only exercises
supported arguments cannot distinguish "handled" from "ignored".

## What is NOT claimed

- **Not** that any of these is a data-corruption risk. All three are read-path or no-op behaviours; instance
  3 was verified against a pre-probe snapshot to have mutated nothing.
- **Not** that the transition route is wrong to transition owner/blockedOn. That is its documented purpose
  and it does it correctly. The defect is that it accepts an argument outside that purpose.
- **Not** an exhaustive audit. I found three on one API **without looking for them** — which is what suggests
  a pattern rather than three coincidences. Whether other routes do the same is untested, and worth a sweep.
- **Not** measured on any other agent. One machine, one API.
