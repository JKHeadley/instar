# Convergence Report — Project apps, part 2 (custom apps in a sealed frame with a narrow per-project key)

## Cross-model review: codex-cli:gpt-6-astra

GPT-6 Astra (the agent's Codex login, run from a freshly built worktree) reviewed every round (1–6) and the targeted verification of the cap fixes. The Anthropic clean-door reviewer was not used.

## ELI10 Overview

Part 1 lets a project show one of Instar's own pages. Part 2 lets the agent build a small app for one project — a sales pipeline, a course tracker — and show it the same way. Because the agent writes the code, the design assumes that code is hostile: a hijacked agent is the real risk (Justin, 16:28).

So the app runs in a locked box the browser treats as coming from nowhere: it cannot see the dashboard's sign-in or anything on the page, and it gets a narrow key that can only read and write its own app's data. Which version of the code runs is decided only by the owner's phone: every new version becomes a card the owner approves with their phone (the agent cannot fake that, even though it knows the dashboard PIN). Everything an app stores is encrypted, so the owner can erase an app's data — or the whole app — by having every machine destroy the keys.

The honest limit is stated up front: an agent with shell access on the host can change anything that host does, including the code it serves; nothing here claims otherwise. The design protects against the common case — an agent hijacked through content, acting through Instar's API, and the app's own code in the owner's browser.

## Original vs Converged

- **Threat model:** originally it claimed to stop a shell-access agent. After review it says plainly that it cannot, and protects the API-only case, the owner's phone, and what lives in the owner's browser.
- **Who decides which code runs:** originally the dashboard tap; then a phone Face ID approval record; finally an Approve on a **server-written Work Board card** from the owner's phone (presence-signed, bound to the card's exact material, recorded at card creation so later builds can't invalidate it). Console (PIN) taps are refused on these cards.
- **Storage:** originally Instar Documents (wrong fit: markdown, shared editors). Then chunks in a journal kind keyed by version number (collisions). Finally: encrypted, base64 chunks under a 64 KiB serialized cap in their own kind, HLC-keyed revisions, written only by the lease holder (writes elsewhere forwarded server-side over the mesh), a catch-up barrier before serving after a restart.
- **Erasure:** originally "compaction" that does not exist. Finally: every stored byte encrypted with per-app keys kept outside the journal and secret sync (which has no delete or fetch), fetched from the lease holder over a signed mesh verb, destroyed by replicated revoke records with a deny-list and per-machine confirmation; phone-approved Erase and Delete cards.
- **Flooding:** one open card per app and purpose (deterministic ids), one message when it opens, a pool-wide budget admitted by the lease holder, an apps-per-agent cap, all raised only from the phone.
- **Frame:** the PIN tripwire was dropped (the agent already knows the PIN); typed-password risk is stated as a residual with the bar text and the version check's flags; key renewal is bound to the loaded version with a bounded back-off and breaker.

## Iteration Summary

| Iteration | Reviewers who flagged | Design findings | Spec changes |
|-----------|-----------------------|-----------------|--------------|
| 1 | security+adversarial, 4-lens, GPT, gate (11) | ~16 | honest boundary; Work Board phone approval; hash version ids; base64 chunks; separate kind |
| 2 | all-lens, GPT, gate (7) | 12 | server-rendered card; revisions + content chunks; budget card; console ticket on phone |
| 3 | all-lens, GPT, gate (8) | 8 | served version derived from cards; one card per app; pool-wide budget; erase card; renewal bound to version |
| 4 | all-lens, GPT, gate (6) | 5 | CUT to one coordinator (lease holder); per-app per-kind chunks; encrypted data + key destruction; pinned card material |
| 5 | all-lens, GPT, gate (4) | 7 | everything encrypted; key file + mesh fetch + revoke records; server-side write forwarding; card generations |
| 6 (cap) | all-lens, GPT, gate (2) | 5 | fixed at the cap (below), then a targeted verification pass |

Standards-Conformance Gate: ran every round (11, 7, 8, 6, 4, 2 flags). Internal reviewers: Claude Opus 5.5 subagents.

## Proportion

Tier 2+ (security-sensitive, new authority surfaces, replicated encrypted storage); ~190 spec lines; 6 of 6 rounds plus one targeted verification of the cap fixes. ⚠ This is a large feature by nature (a sandbox, a key system, phone approvals, erasure); the findings fell steadily (16 → 12 → 8 → 5 → 7 → 5) and shifted from architecture to distributed-state details, which is where a further cut (one coordinator) was made.

## Left behind

- **Fixed at the cap, then checked by two targeted verification passes (safety/data-loss class).** Pass 1 (GPT + internal) found the revocation-on-failover gap, plain-text summaries and summary bytes outside the budget; fixed. Pass 2: the internal reviewer found **no remaining safety, security or data-loss design issues**; GPT raised three narrow items, fixed in the spec without a further read (a new holder also recovers revisions and refuses writes until it has — consistency wins; an erase covers every key generation up to the approve; phones replace an erased summary on their next read, and an offline phone's saved copy is disclosed). Earlier cap fixes: key generation in revisions and disk paths; budget history kept across lease handovers (only fenced late writes set aside); catch-up barrier before serving or fetching keys after a restart or reconnect; change notes encrypted with the source key; purpose-specific bound records and card ids for enable / budget / erase-data / delete-app; withdraw-approval acts as disable; key file on the backup blocklist; a returning older key generation re-offered.
- **Accepted (gate, Judgment Within Floors):** default sizes (2 MiB source, 1 MiB data, 8 MiB a day, 10 apps, 60-character title) are starting values the owner raises from the phone; their basis is stated, not claimed as limits of nature.
- **Accepted (gate, Multi-Machine):** a write is acknowledged once the lease holder has it durably; a holder lost before replicating can lose its last writes (the same durability every journal kind has), shown on the row as "last saved on <machine> at <time>".
- **Accepted (scalability):** boot replays every revision record (bounded by the budget; not compacted, because the journal has no per-key compaction).
- **Accepted (tension):** the key-renewal breaker stops after two hours and offers Try again (No Unbounded Loops) rather than retrying forever (No Manual Work).

## Full Findings Catalog

Per-round findings and resolutions: `.instar/lanes/project-apps-sandbox/round1-findings.md` … `round6-findings.md` (agent home), with each round's spec snapshot (`spec-r1.md` … `spec-r6.md`, `spec-r6-capfix.md`), gate reports (`conformance-r1.json` … `conformance-r6.json`) and GPT results (`ext-codex-r1.json` … `ext-codex-r6.json`, `ext-codex-capfix.json`).

## Convergence verdict

Converged at the round cap (6) with two targeted verification passes of the cap fixes. The last internal pass found no remaining safety, security or data-loss design issue; the last three GPT items were narrow and are fixed in the text as listed above (not re-read by a model — disclosed here so the build's tests carry them: takeover recovery, the erase watermark, the phones' saved copy). Remaining items are accepted risks listed above. Ready to build; approval is Justin's "go!" (topic 141385, 2026-11-16 16:34 PST) on the recommendation this spec implements.
