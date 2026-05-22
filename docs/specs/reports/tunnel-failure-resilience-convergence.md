# Convergence Report (in progress) — Tunnel Failure Resilience

> **Status: iteration 1 (internal) + iteration 2 (external GPT) complete.
> NOT yet converged.** Owes a convergence-verification round and an
> external Gemini round (local OAuth blocked non-interactively); Grok has
> no CLI in this env. `approved: true` is the operator's step after
> reading the plain-English summary below. This file is the running
> record.

## ELI16 Overview

instar puts your dashboard online through a Cloudflare tunnel. When
Cloudflare rate-limits us, the link just vanishes with no explanation.
This spec makes the tunnel layer (1) tell you in the Dashboard topic what
broke and why, (2) fall back to other ways of getting a link, and (3)
heal itself by switching you back to your normal link the moment
Cloudflare recovers.

The safety rule you set: the automatic backups stay on Cloudflare (which
you already trust). The two no-account relays send your private traffic
through a stranger's servers, so the agent must ask you first before
using one — and only the owner can say yes.

## What the internal review changed (original → reviewed)

The first draft was a reasonable sketch, but four reviewers (security,
adversarial, integration, state-machine) found the sketch would have been
**net-worse than today** if built as-written, mainly because it bolted a
new control loop on top of three loops that already exist. The reviewed
version is meaningfully different:

1. **It now explicitly retires the old retry code.** instar already has a
   startup-retry ladder, a background-retry ladder, and a reconnect loop
   for the tunnel. The draft added a fourth owner without removing them —
   which means duplicate "back online" messages and competing restart
   attempts. The reviewed spec consolidates ALL of it into one owner.

2. **Consent is now locked to you specifically.** The draft let any
   member of the group approve routing private traffic through a relay.
   Now only the owner can, and approval is a tap on a one-time button —
   not a typed "yes" that could be faked or misread.

3. **It now refuses to thrash your link.** The draft would have switched
   your live link back and forth every time Cloudflare flickered. Now it
   waits for Cloudflare to be steadily back before switching, and tears
   down the relay forcefully so your traffic stops flowing through the
   stranger.

4. **It's now honest about what a relay exposes** (your dashboard PIN and
   signed links travel through it) and rotates your PIN after a relay
   episode so anything leaked stops working. `bore`, which is unencrypted,
   is now off by default.

5. **The notification will actually reach the Dashboard topic.** The draft
   would have always fallen back to Lifeline on first boot because of a
   startup ordering bug; that's fixed.

## Iteration 1 — findings catalog

Reviewers: security, adversarial, integration, state-machine/concurrency
(internal Claude subagents, run 2026-05-22). 4 CRITICAL / 8 HIGH / ~10
MEDIUM-LOW. All material findings resolved in spec v2.

| # | Sev | Reviewer(s) | Finding | Resolution |
|---|-----|-------------|---------|------------|
| 1 | CRIT | adversarial, integration, concurrency | 3-4 competing retry loops; new lifecycle = double ownership, duplicate broadcasts | "Single-owner mandate": server.ts ladders + Lifeline msg removed; one backoff engine in manager |
| 2 | CRIT | security | Consent accepts any `authorizedUserIds` member, not the owner | Owner-bound; inline-button + one-time nonce; non-owner click rejected |
| 3 | CRIT | concurrency | No single-writer guard; error+exit race double-advances provider | CAS-guarded `transition(expectedFrom,to)`; all handlers route through it; monotonic epoch |
| 4 | CRIT | concurrency, adversarial | `awaiting-consent` undefined for mid-window events; stale "yes" activates relay after recovery | Episode-scoped consent+nonce; Tier-1 recovery cancels consent; late yes is no-op |
| 5 | CRIT | integration | Dashboard topic id undefined during failure window (startup ordering) → always falls back to Lifeline | `ensureDashboardTopic()` moved ahead of tunnel start / lazy-ensure |
| 6 | HIGH | security | `relayConsent:'always'` silent-exposure footgun | Dropped from v1 |
| 7 | HIGH | adversarial, concurrency | "One msg per transition" doesn't bound spam under flapping | Hard floor 1 msg/15min/episode; flapping collapses to one "unstable" msg |
| 8 | HIGH | adversarial, concurrency | Self-heal thrashes live URL under flapping | N-consecutive-success stability gate; new-then-old atomic switch; rate-limited notices |
| 9 | HIGH | adversarial | `start()` resolves on URL emission, not reachability → false `active` | Mandatory post-start `/health` probe through public URL before `active` |
| 10 | HIGH | security | Consent text understates leak (PIN + HMAC `sig` from authToken, replayable) | Honest consent text; rotate `dashboardPin` after episode; authToken rotation noted |
| 11 | HIGH | security | bore is plaintext TCP | bore disabled by default; distinct consent wording |
| 12 | HIGH | integration | bore has no install/resolution path | `isAvailable()=false` unless checksum-verified path added; dropped from offered list when absent |
| 13 | HIGH | security | TOCTOU consent-grant → relay-start; bore reused under localtunnel consent | Single-use consent bound to (episode,provider,owner,issuedAt); per-provider approval |
| 14 | HIGH | concurrency | consent + self-heal timers leak on stop(); pile up per episode | Track + clear all timers in stop/forceStop/disableAutoReconnect |
| 15 | MED | integration, adversarial | Config key mismatch (Part4 vs Part6); migrateConfig ignores ConfigDefaults.ts | Names reconciled; defaults via `ConfigDefaults.ts MIGRATION_DEFAULTS.tunnel` |
| 16 | MED | adversarial, integration | Boot-time consent has no recipient if Telegram/topic not up | Gate `awaiting-consent` on confirmed channel; else `exhausted`+bg retry |
| 17 | MED | security | Token/PIN leak in logs / `tunnel.json` | Redaction helper at all callsites; unit test asserts no credentialed URL logged/persisted |
| 18 | MED | security | Self-heal teardown must guarantee relay process death | Relay `stop()` escalates SIGINT→SIGKILL + PID verify; confirm before "link is back" |
| 19 | MED | integration, security | Consent-reply races normal message dispatcher | Inline-button callback handler, separate from inbound dispatch; no free-text path |
| 20 | MED | concurrency | Stale-URL window in switch-back | New-then-old ordering |
| 21 | MED | integration | Testability of timers + Telegram I/O | Clock/timer injection; `sendToTopic` seam; `/tunnel` state surface |
| 22 | LOW | concurrency | `consentTimeoutMs` 10min collides with 10-attempt reconnect window | Staggered to 15min |
| 23 | LOW | integration | CLAUDE.md parity needs both generate + migrate | Part 7 names both with content-sniff guard |
| 24 | LOW | concurrency | `exhausted → self-healing` transition unlisted | Added explicitly |
| 25 | LOW | integration, security | Non-forum group: no Dashboard/Lifeline topic | General-topic fallback; skip consent if none |

## Remaining open questions (for the external round)

1. `localtunnel` supply-chain (adds axios/yargs/etc. as prod deps) — accept
   or vendor a thinner client?
2. Per-episode `dashboardPin` rotation — right default, or too disruptive?
3. Ship `bore` in v1 at all, or localtunnel-only now + bore follow-up?

## Iteration 2 — external GPT (via codex / ChatGPT subscription OAuth)

Reviewer: `codex exec -m gpt-5.3-codex` (one round, 2026-05-22). Validated
that "external catches what internal misses": 7 NEW material findings
beyond what the four internal reviewers had surfaced. All folded into
spec v3.

| # | Sev | Area | Finding | Resolution in v3 |
|---|-----|------|---------|------------------|
| E1 | CRIT | privacy | Group-posted URL+PIN defeats owner-only consent — anyone in the group sees the credentials | Two-channel notify: group=status only, owner DM=credentials |
| E2 | HIGH | crypto/replay | PIN-only rotation leaves HMAC-signed view URLs (sig from authToken) replayable for their lifetime | `authToken` rotation upgraded from "follow-up" to mandatory on every relay episode end |
| E3 | HIGH | supply chain | The user consent gate is a privacy mitigation, NOT supply-chain — localtunnel runs in-process regardless | Hardened-dep posture: exact pin, provenance check, fresh-release cooldown, child-process isolation; minimal audited client carried as alternative |
| E4 | HIGH | telegram callback | "One-time nonce" was conceptual — entropy, atomic consume, chat/message binding, keyboard invalidation all unspecified | Concrete spec: ≥128-bit CSPRNG nonce, atomic compare-and-delete, `(episodeId, provider, ownerId, chatId, messageId, issuedAt)` binding, editMessageReplyMarkup on every terminal transition |
| E5 | HIGH | UX integrity | 15-min floor could suppress the consent prompt or recovery messages → fallback never activates | Class-based throttling: `action-required` (consent prompt, link-delivered pointer) never throttled; `state-change` light; `noise` heavy |
| E6 | HIGH | api leak | `GET /tunnel` exposes provider/state/failure-reason without an auth policy | Bearer-auth-gated; minimized response for non-owner principals; failure-reason text scrubbed |
| E7 | HIGH | self-inconsistency | Part 3 "send URL+PIN in notifications" vs. Part 6 "redaction at every notify callsite" — both cannot hold | Reconciled by E1's two-channel split: redaction strict for logs + group; owner DM is the only credential path |

## What changed between v2 (internal-reviewed) and v3 (external-reviewed)

The big structural shift: **credentials never reach the group topic
anymore.** v2 still routed the URL + PIN to the Dashboard topic on
recovery / relay-activation, which would have let anyone in the group
read them — defeating the owner-only consent gate completely. v3 splits
delivery into two channels: group topics carry STATUS TEXT ("backup is
up; link sent to your DM"), and the owner DM is the only place the URL
and PIN actually appear. Same for the consent prompt itself — it now
lives in the owner DM, with the group getting just a pointer.

The other notable upgrade: `authToken` rotation is now mandatory (not a
follow-up). The UX cost is real (the operator's dashboard sessions log
out, and any previously-shared signed view URLs stop working) but it's
the only mitigation that actually closes the replay window. The spec
documents this trade plainly in the owner DM message.

## Iteration 3 — GPT verification on v3 (NOT converged)

V3 verification surfaced 2 new HIGH findings — neither restated the
prior seven, both genuine gaps in v3's wording:

| # | Sev | Area | Finding | Resolution in v4 |
|---|-----|------|---------|------------------|
| V1 | HIGH | credential lifecycle | `authToken`/PIN rotation only triggered on `relay-active → active | exhausted`; idle/crash/`stop()`/shutdown paths could leave a relay-exposed token live | Rotation broadened to EVERY terminal exit from `relay-active` (including `idle`, shutdown, crash); a `rotation-pending` flag persisted in `tunnel.json` is the crash-safe marker; on boot, if the flag is set OR last state was `relay-active`, rotation runs BEFORE the server accepts any API traffic |
| V2 | HIGH | abuse-amplification | `action-required` "never throttled" + persistent Cloudflare outage → unbounded consent DMs / alert fatigue | Cross-episode cooldown for the consent prompt: N declines/timeouts (default 3) triggers exponential back-off (1h → 4h → 24h, capped); release on explicit owner opt-in or fresh post-cooldown episode |

## Iteration 4 — GPT verification on v4 (CONVERGED)

Verdict: **CONVERGED — no new material issues.** GPT confirmed v4
materially closes both V1 and V2, and the fixes did not introduce
new risks.

## Convergence verdict

**Converged at iteration 4.** Total: 32 material findings (internal
iter1) + 7 (GPT iter2) + 2 (GPT verification iter3) = 41 material
findings across 3 reviewer waves; all resolved in spec v4. The external
Gemini round was skipped per operator decision (local OAuth blocked in
this env, dev-context wiring not available here, and the GPT-only
external round was acknowledged as meaningfully better than internal-
only). Grok is unavailable in this environment (no CLI installed).

Operator approval received via Telegram on 2026-05-22 ("OK, thanks yeah,
let's move forward with the recommendations"). Both `approved: true`
and `review-convergence: 2026-05-22T20:30:00Z` tags are set on the spec
frontmatter. Implementation may now begin under the `/instar-dev` flow.
