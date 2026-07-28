# Ownership-Gated Spawn — the three core flows (implementer map)

Companion to `docs/specs/ownership-gated-spawn-and-judgment-within-floors.md`
(§8 [core] deliverable). The glossary in §3 defines the terms; these diagrams
are the walk-through. All three flows are drawn at ENFORCE maturity — in
Increment 1 (dryRun) every refusal below is a journaled would-block and the
legacy path proceeds unchanged.

## Flow 1 — inbound message arrives at a NON-owner machine

```mermaid
sequenceDiagram
    participant U as User (Telegram/Slack)
    participant FD as Front door (non-owner machine)
    participant R as SessionRouter
    participant SA as SpawnAdmission (seam)
    participant Q as Durable inbound queue
    participant L as OwnerDarkLadder

    U->>FD: message for topic T (owned by machine M)
    FD->>R: route(T)
    R-->>FD: verdict (queued / forwarded / ...)
    Note over FD: legacy bug: fall-through IGNORED the verdict<br/>and spawned locally 6ms later (2026-07-10)
    FD->>SA: admit(T, callsite, routerVerdict)  [TOCTOU: verdict CONSUMED, never re-derived]
    alt verdict = queued / placement-blocked
        SA-->>FD: refuse (rung3-notice)
        FD->>Q: enqueueLive(T) — durable custody
        FD->>L: handleOwnerDark(T, custodyLive)
        L->>L: pre-send liveness re-check + topic-history suppression + episode dedupe + cooldown
        L-->>U: ONE honest notice ("saved, will be answered" / "please resend")
    else owner alive (forward row)
        SA-->>FD: refuse (forward) — router/queue owns delivery
    else self / unowned
        SA-->>FD: allow — spawn (today's behavior)
    else registry error (row e)
        SA-->>FD: allow — reachability wins, bounded:<br/>once-per-topic journal + deduped item + windowed breaker
    end
```

## Flow 2 — duplicate detected → record converged → closeout closes the spare

```mermaid
sequenceDiagram
    participant DR as DuplicateSessionReconciler (lease holder)
    participant P as Pool view (bounded fan-out)
    participant M2 as Non-owner machine
    participant REG as SessionOwnershipRegistry (fenced CAS + journal)
    participant SW as SessionReaper closeout sweeper (on M2)

    loop every reconcilerTickMs (60s)
        DR->>P: discover duplicates (same platform:platformId live on ≥2 machines)
        DR->>M2: FRESH direct probe (5s) — duplicate still exists? owner has live copy?
        DR->>DR: intended owner: pin → highest ADMISSIBLE epoch → registered live run → ESCALATE
        Note over DR: both-live-runs / epoch-vs-run contradiction /<br/>equal epochs / CAS 409 → ONE attention item, never a guess
        DR->>REG: casConverge(T, owner) — fenced claim, epoch++
        REG-->>M2: journal replication fast-forwards M2's own view
        DR->>M2: peer-echo check (/pool/ownership-view) within echoConfirmTicks
        alt echo observed
            Note over SW: M2's own sweeper sees topicOwnerElsewhere=true<br/>off its OWN (converged) view — the record IS the arming
            SW->>SW: confirm ticks + fresh guard re-checks + terminate-time re-probe
            SW->>M2: close the spare copy (reap-log: duplicate-reconciled)
        else no echo
            DR->>DR: escalate convergence-not-observed (per-tick aggregated)
        end
    end
```

## Flow 3 — commitment-shielded closeout (the §3.2.4a correction, Increment 2b)

```mermaid
sequenceDiagram
    participant SW as Closeout sweeper (closing machine)
    participant RG as ReapGuard
    participant OWN as Owner machine
    participant CT as CommitmentTracker (origin machine)

    SW->>RG: KEEP guards (fresh, at terminate time)
    Note over RG: open-commitment / recent-user-message KEEP —<br/>carve-out honored ONLY when BOTH hold:
    RG->>RG: (i) disposition-appropriate provenance fence in the LOCAL view<br/>(reconciler-minted convergence record, or the transfer-minted CAS record)
    RG->>OWN: (ii) terminate-time re-probe — owner copy LIVE and serving (5s)
    alt both hold
        SW->>SW: close the spare copy
        SW->>OWN: read origin's open topic-scoped commitments (authenticated mesh read)
        OWN->>OWN: mint successor via its own POST /commitments<br/>(externalKey custody:<topic>:<origin-id>, clamped+enveloped fields)
        OWN-->>CT: ACK (successor exists)
        CT->>CT: origin-side supersede verb — fenced to the VERIFIED successor —<br/>terminal `superseded-by-ownership-move` (own single-writer CAS)
    else fence or probe fails
        RG-->>SW: VETO (KEEP) — defer to next tick; custody moves ONLY after a confirmed close
    end
    Note over SW,CT: no ACK → origin records untouched + ONE custody-transfer-failed item.<br/>Flag dark/unavailable → open-commitment duplicates ESCALATE, never auto-close.
```
