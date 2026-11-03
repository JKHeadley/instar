# Convergence Report — Phone pairing works over the agent's own Tailscale name, and pairing links last 30 minutes

## Cross-model review: codex-cli:gpt-6-astra

A real GPT-tier external pass (codex CLI, gpt-6-astra) ran on all three rounds, each on a different spec body. Gemini was not authed (`gemini-not-authed`); grok not enabled. The Standards-Conformance Gate ran every round. Internal reviewers ran as Claude Opus 5.5 subagents (session model claude-opus-5-5, no escalation).

## ELI10 Overview

When you connect the Instar iPhone app to an agent, the agent makes a one-time link, the phone opens it, and you type a 6-digit code that only you can see. Until now the agent would only make that link if it had a Cloudflare web address running. A cloud server that only had a private Tailscale address (which your phone could already reach) simply refused. The links also ran out after 10 minutes, and the phone's waiting request after 15, so on 2 November it took three links to pair one phone.

This change lets the agent use its own Tailscale address when Cloudflare isn't running, but only an address the agent has proven leads to itself. Links and the waiting request now last 30 minutes. The safety steps do not change: the link works once, and you still need the private 6-digit code.

The trade-off is that a leaked link stays usable for 30 minutes instead of 10. It still pairs nothing without the code that only you see.

## Original vs Converged

- **A link now remembers which address it was made for.** Originally, when the phone used the link, the agent re-decided which address it "preferred" right then. If Cloudflare came back in the meantime, or one background health check had a hiccup, a perfectly good Tailscale link would be refused, which is the same circular frustration the change was meant to remove. Now each link stores its address at creation and is accepted on exactly that address while it is still the agent's own.
- **Health checks inform, they don't block.** Originally, a Tailscale address counted only if its last background check had passed, which right after a restart was "not checked yet", so a freshly restarted agent would refuse. Now the address counts if the agent's own Tailscale setup names it, and the 8 live check-ins at link creation decide.
- **Backup relays can't sneak in, but the normal tunnel doesn't block pairing.** Reviewers noticed that an outside backup relay could deliver a request pretending to arrive by Tailscale. The first fix (block pairing whenever any non-standard tunnel is active) would have blocked Tailscale pairing forever on every default install, because the default Cloudflare quick tunnel runs permanently. The final rule blocks only while a third-party relay is carrying traffic.
- **A spare machine refuses up front.** With the fallback, any machine could now make a link, including a standby that can't deliver your code. It now says so before making the link instead of failing after you open it.
- **The Cloudflare branch can't be used through the back door.** The own-address list also contains the Cloudflare name even when that tunnel is down, so the redeem check now accepts only Tailscale-kind names through that branch.
- **The agent knows.** The mint response says which kind of address was used, and the agent's instructions (template plus an update migration for existing agents) say "30 minutes by default", explain both ways to get an address, and tell it to warn you that a Tailscale link needs Tailscale on your phone.
- **Tested like a user first.** Before asking you to pair, a script pairs over the Tailscale name as the app would, then the real app pairs in the iOS simulator, which also checks that the app accepts a `ts.net` address.
- Corrected facts: the self-check makes 8 pings, not 3.

## Iteration Summary

| Iteration | Reviewers who flagged | Design findings | Left behind | Spec changes |
|-----------|-----------------------|-----------------|-------------|--------------|
| 1 | security, adversarial, lessons, integration, decision-points, decision-completeness, codex | 12 (deduped: redeem recomputes origin; probe health as gate; relay/forwarder Host gap; standby mint; hostname-less named tunnel blocks fallback; wrong ping count; agent awareness + migration; decision table; multi-machine marker; frontloaded decisions/open questions; ts.net in published `o=`; rollback overclaim) | 9 | Sections 3–9 rewritten |
| 2 | integration (forwarder rule blocks default installs), codex (own-names branch admits Cloudflare names; live test can't prove app dependency) | 3 | 6 | Relay rule narrowed; Tailscale-kind-only redeem branch; simulator app test |
| 3 | (converged) | 0 | 8 | One-line precision fixes |

Standards-Conformance Gate: round 1 ran (2 flags: multi-machine justification missing; live-user-channel proof — both resolved); round 2 ran (0 flags); round 3 ran (0 flags).

## Proportion

Tier 1 (≈125-line spec; code change ~40 lines in three files plus template/migration). 3 rounds of a 3-round cap. Round 1 was heavy because the draft was written before the decision-point, multi-machine and frontloaded-decision sections; the design itself changed materially (binding, relay rule), which justifies the rounds.

## Left behind

- `/mobile/routes` with multi-route off labels a Tailscale-paired host `kind: "cloudflare"` (cosmetic; only reachable after a revert on a dev agent).
- Mint worst case ≈41 s (8 × 4 s pings + `proveNow`); normal case sub-second. Callers' outer timeout should exceed it.
- A server restart still drops live links and pending devices within the 30 minutes (stated in §3.3).
- The 409 detail points at `/health → mobileRoutes`; the agent template carries the plain-words explanation.
- Tailscale Funnel can make the `ts.net` name public; harmless, since secrets are the gate (§4 says "reachability grants nothing").
- Own names are dropped only on an `another-process` probe failure, not on timeout; mint stays safe through `verifySoleServer`.
- During the few seconds a just-consented relay is probed, the lifecycle still reads `awaiting-consent` (accepted, stated in §3.1).
- Order of pre-take checks (approval vs host) changes only which error a doubly-bad request sees; pick one and test it.

## Full Findings Catalog

Round 1 (internal security/adversarial/lessons):
- DESIGN D1 redeem re-evaluated `pairingOrigin()` → stranded links on route change/probe blip. Resolved: code binds `{host, kind}`; redeem requires equality (§3.2).
- DESIGN D2 `lastProbeOk === true` gate (null after boot; Signal-vs-Authority). Resolved: `accepts()` + self-check; health is preference (§3.1).
- DESIGN D3 loopback forwarder (relay) can carry a forged Host. Resolved: relay check (§3.1, §4), narrowed in round 2.
- DESIGN D4 agent awareness + migration parity; mint response kind. Resolved: `originKind`, §3.4.
- DESIGN D5 rollback claim half true. Resolved: §9 rewritten.
- PRECISION P1–P5 (Funnel publicness, dropped-name wording, line numbers, confirm-code lifetime, 409 pointer): P3/P4 fixed in passing, rest left behind.

Round 1 (internal scale/integration/decision lenses):
- DESIGN decision-point section unclassified → table (§5).
- DESIGN multi-machine marker missing → `physical-credential-locality` (§6).
- DESIGN no Frontloaded Decisions / Open questions → added (§7, Open questions none).
- DESIGN redeem re-chooses origin (dup of D1); probe health at redeem (dup of D2).
- DESIGN standby can mint an unredeemable link → mint approval/lease check (§3.1).
- DESIGN hostname-less named tunnel 409 runs before fallback → moved (§3.1).
- DESIGN "three pings" wrong → 8 (§2, §3.1).
- DESIGN template/migration (dup of D4).
- DESIGN `o=` published interface → frontloaded (§7).
- DESIGN Cloudflare self-check failure fallback undecided → frontloaded: no fallback (§7).
- PRECISION: misleading 409 when not yet probed (moot after D2), rollout gate (added §3.5), rollback qualifier, restart caveat (added), mint latency (left behind), limits arithmetic (added §3.3), name ordering (tiebreak added), missing tests (added §8).

Round 1 (codex): DESIGN redeem preference/health dependency (dup of D1/D2). PRECISION verification scope (n/a: internal reviewers read the source).

Round 1 (gate): multi-machine justification (resolved §6); live-user-channel proof (resolved §8 user-role run first).

Round 2 (internal): DESIGN forwarder rule permanently blocks default installs (quick tunnel is permanent, `TunnelManager.ts:496/567`). Resolved: relay-only (`relay-active`/`self-healing`). PRECISION: `accepts()` admits Cloudflare names (escalated by codex), approval check order, §2 wording, §3.5 revert overstated (fixed), quick-tunnel test (added).

Round 2 (codex): DESIGN own-names branch admits an inactive Cloudflare name → Tailscale-kind only + kind match (§3.2). DESIGN live script can't prove the app accepts `ts.net` → simulator app test (§8). PRECISION "deterministic proof" overstated → reworded (§3.1).

Round 3 (internal): no design findings; precision: relay probe window (accepted, stated), local processes (clause added), `accepts()` ignores kind (build note added), Cloudflare Host passthrough confirmed (no `httpHostHeader` in providers), pre-take order (left behind).

Round 3 (codex): MINOR; precision: split wrong-host test (fixed), guidance conditions (fixed), lifetime is a trade-off (fixed).

## Convergence verdict

Converged at round 3. The final round found nothing that changes what gets built; 8 items left behind. After round 3 a `## Maturation plan` section was added at the tag writer's request; it restates §3.5 (the fallback rides the multi-route flag and its CMT-1192 dark-window) and adds no design. Spec is ready for approval.

What the code must do beyond the original draft: store `{host, kind}` with each pairing code and require redeem's Host and kind to match it; choose a Tailscale name by `accepts()` (kind-checked) without requiring a passed probe; refuse Tailscale-bound mint/redeem only while the tunnel lifecycle is `relay-active` or `self-healing`; run the hostname-less-named-tunnel 409 only when no origin exists; refuse mint when the approval path is unreachable on this machine (Telegram path without the lease); add `originKind` to the mint response; update the CLAUDE.md template and PostUpdateMigrator text; extend tests as §8 lists.
