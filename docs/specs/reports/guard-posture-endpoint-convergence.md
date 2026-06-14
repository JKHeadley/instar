# Convergence Report — Guard-Posture Endpoint

## ELI10 Overview

This adds a way to ask any of your machines — from anywhere — "which of your safety systems are genuinely working right now?" Today that's impossible: settings can be written remotely but not read, and the one existing alarm only fires at restart when a guard gets switched off. That blindness is how the Mac Mini's session cleaner stayed off for a week in June, until the machine was nearly out of memory.

The design gives every guard an honest grade (confirmed working / on-paper-only / frozen / practice-mode / off), splits "off" into "off because it ships that way" versus "off when it shouldn't be" (so the one alarming off doesn't drown in a wall of normal ones), carries a tiny posture summary on the heartbeats machines already exchange (so even an unreachable machine's last-known state is visible, with its age), and adds a background check that raises one grouped alert when something is genuinely wrong. It is strictly read-only.

The main tradeoff: knowing which defenses are off is sensitive information, so everything sits behind the same authentication as the rest of the admin API, the data never appears on weaker surfaces, and machine-to-machine connections get an extra URL safety check before any credentials are attached.

## Original vs Converged

The original draft was a simple endpoint that scanned the settings file for things that looked like guards and showed on/off counts on the dashboard. Review changed it substantially:

- **"On in the settings" stopped counting as "working."** Reviewers showed the original would paint a crashed or frozen guard green — the exact Mini failure. The converged design grades every guard by what can actually be verified, with a strict precedence order, including a state for a guard whose own runtime admits it's off while the settings say on.
- **The guard list stopped being a guess.** The original inferred guards from a settings naming pattern; reviewers proved that pattern both misses real guards and disagrees with the existing restart-alarm's own list. The converged design shares ONE extraction function with that alarm, adds a declared manifest for guards the settings can't see, and a build-time check so future guards can't be forgotten.
- **"Off" got classified.** Dozens of features ship dark on purpose; without classification every machine would show amber wallpaper forever. Offs that differ from how things ship are the only ones that alert.
- **The fleet view became honest about unreachable machines.** Last-known posture is persisted and age-tagged, every registered machine is accounted for by name (never silently omitted), and a machine running an older version shows "needs update to report" instead of a fake outage.
- **A "turn it back on" switch was added — then deliberately removed.** Round two proved the switch was a much bigger power than it looked (for several settings roots it would be the first remote write path that exists at all, and one key could double model costs in a single call). It moved to its own future design with every open question named, and in the meantime the agents' instructions gain a warning about the existing settings lever's known wipe-siblings behavior.
- **Security tightened from "recommended" to "required":** machine-to-machine posture data binds to the authenticated sender (no peer can paint another machine green), ages come from the receiver's clock (no replay/clock tricks), and the URL safety allowlist became a shipping dependency rather than a suggestion.

## Iteration Summary

| Iteration | Reviewers who flagged | Material findings | Spec changes |
|-----------|-----------------------|-------------------|--------------|
| 1 | security, scalability, adversarial, integration, lessons-aware, GPT (codex), Gemini | ~40 | Full rewrite: honest state vocabulary, shared extractor + registry, off-classification, heartbeat piggyback, probe consumer, projection allowlist, threat model, CI-gate compliance, write lever added |
| 2 | security, scalability, adversarial, integration, lessons-aware, GPT (Gemini degraded: timeout) | 15 | Write lever DE-SCOPED to tracked follow-up; heartbeat channel hardened (sender-binding, receiver clocks, durability); manifest + reconciliation + missing state; precedence table; URL allowlist as dependency; probe episode/flap semantics; lint backfill story |
| 3 | combined-lens internal, GPT | 2 | Residual lever artifacts removed from tests/rollback; `off-runtime-divergent` state added; 4 non-material cleanups folded |
| 4 | combined-lens internal | 1 | `off-runtime-divergent` propagated to the heartbeat block, the probe anomaly list, and AC-5 (the M3 propagation class) |
| 5 | combined-lens internal | 0 (converged) | 3 cosmetic one-liners folded post-verdict |

External-model disclosure: GPT-family reviews ran via codex-cli (gpt-5.5) on all rounds; Gemini (gemini-2.5-pro) completed round 1 and degraded (timeout) on round 2+; Grok-family is not available on this machine. Per the skill's cross-model contract, available families ran every round and degradations are recorded, not hidden.

## Full Findings Catalog

The complete per-round, per-reviewer findings with resolutions are preserved in the session transcript and summarized above; load-bearing resolutions are all visible in the spec text itself (each major section carries its convergence rationale inline). Key reviewer-attributed highlights:
- Security R1-H1/H2: closed-allowlist output projection + alertTopicId leak test (resolved §2.2).
- Adversarial R1-F1/F2/F3/F7: on-config≠on, liveness staleness, single shared inventory, off-classification (resolved §2.1/§2.2).
- Lessons R1-F3 / R2-F12 + Integration R2-F13: the write lever's destructive-merge and authority-expansion problems (resolved by de-scope, §2.5).
- Lessons R2-F11: heartbeat durability + receiver-clock staleness (resolved §2.3).
- Integration R1-F1/F2: Agent Awareness template mandate + CAPABILITY_INDEX classification (resolved §4).
- Combined R3-M2: `off-runtime-divergent` for the in-memory load-shed class (resolved §2.2).

## Convergence verdict

Converged at iteration 5. No material findings in the final round (every convergence-added state verified consistent across the read surface, the heartbeat block, the probe anomaly list, and the acceptance criteria). Spec is ready for user review and approval.
