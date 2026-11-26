# Convergence Report — Normal-Chrome browser method as a built-in skill

## ⚠ Cross-model review: DEGRADED — ALL ROUNDS (degraded-all-rounds)

The only cross-family (non-Claude) reviewer available on this machine was the codex CLI (`gpt-5.5`). It was attempted in all nine rounds and failed every time (`reason: error`); a bare `codex exec "say ok"` also hung with no output, so the CLI itself is not answering here today. Gemini is not signed in (`gemini-not-authed`). Remediation: re-authenticate the codex CLI (`codex login`) or sign in to gemini, then rerun one external pass.

What did run in every round: a clean-door second read by `claude-fable-5` through the plain `claude -p` door (a different session and prompt, same model family, so not cross-model independence), plus one internal multi-angle reviewer (lessons-aware, security/adversarial, integration/migration parity, decision-completeness) from round 3 on.

Standards-Conformance Gate: ran in round 1 but answered `degraded: true, degradeReason: error` (92 standards loaded, no findings returned). Recorded as unavailable for rounds 1–9; it never blocked.

## ELI10 Overview

Some web jobs have to be done as a particular signed-in person: reading a usage page, changing a setting. Account pages often treat automated browsers differently. On 21 October 2026 Echo found a way to run a completely normal Chrome window per account and control it with the Mac's own scripting system. Justin asked for that to become something every Instar agent has.

This change gives every agent a written procedure (`/normal-chrome-browser`) and three small tools that open a normal Chrome for one of the agent's profiles and run JavaScript in it. It also adds a short note to every agent's instructions saying when to reach for them. It works only on Macs, says so, and stops cleanly elsewhere.

The main trade-off: a browser that a website treats like a person's is powerful, and only written rules restrain how it is used. So the shipped version is deliberately narrower than what Echo did on the day. It never fakes a person's attention to make a button work, its example only reads a page, and the operator decides whenever a site's terms or a page's rules stand in the way.

## Original vs Converged

- **Faking a person's presence was removed.** The original skill's showpiece step dispatched a synthetic "window has focus" event so a claude.ai button would arm in a background window, and its worked example claimed promotional resets across several accounts. Round 1 asked for a boundary. In round 3 the clean-door reviewer declined to keep reviewing a fleet-wide skill that teaches synthesizing presence signals, and said the terms-of-service question belongs to a human. That was accepted. The shipped skill reads the page's code only to explain why a control is withheld, forbids synthetic presence signals, and uses a read-only example.
- **The tools can no longer reach the operator's own Chrome.** Originally any absolute path was accepted. Now every path is canonicalized (`..` and symlinks resolved) and must sit inside the agent's home. Within `.instar/` only the profiles folder is allowed, and the operator's Chrome folder is always refused. Round 4 found a real escape in the first version of this jail; it is fixed and tested.
- **A missing profile is no longer silently created.** That used to open a signed-out browser that looks like a lost login. Now it needs `--new`.
- **Results can't be faked by the page, and failures can't pass as successes.** Results now come back in an envelope tagged with a per-call secret the page cannot see. Exit codes come only from that envelope. A blocked in-page script reports itself instead of handing back the previous call's answer.
- **Clicks can't land on the wrong page.** An optional expected-origin check runs in the same evaluation as the code.
- **A best-effort activity line per call** records time, profile, origin and a code hash, never the content.
- **Codex agents get the rules too.** Skills install only for Claude Code agents, so the instructions section itself carries the safety and profile rules.

## Iteration Summary

| Round | Reviewers who flagged | Design-class | Precision-class | Spec changes |
|---|---|---|---|---|
| 1 | clean-door | 4 | 2 | guard boundary, CSP did-not-run, stale-result fix, alternatives section, decision rows |
| 2 | clean-door | 2 | 3 | report every guard action, expected-origin check, sync-only note |
| 3 | clean-door (declined), internal | 6 | 3 | presence-faking removed, read-only example, jail, `--new`, registry-503 fallback, rules in CLAUDE.md section, one-event origin check, untrusted page text |
| 4 | internal, clean-door | 2 | 4 | realpath jail (escape found), wording that still implied synthetic events, decision row relabelled |
| 5 | internal, clean-door | 2 (low) | 5 | registry id rule, whitespace refusal, reserved folders, exit codes, activity line |
| 6 | internal, clean-door | 2 | 6 | caller-code hash for main-world calls, allowlist, resolved-path whitespace check |
| 7 | clean-door | 2 | 4 | nonce result envelope, trailing-comment newline |
| 8 | (none) | 0 | 8 | function scope for main-world code, agent-home space check, wording |
| 9 | (none) | 0 | 6 | recovery rows, two tests, activity-line ordering |

Standards-Conformance Gate: round 1 ran and answered `degraded: error`; rounds 2–9 unavailable (same server answer); never blocking.

## Full Findings Catalog

- **R1 (clean-door):** (D) the safety rule contradicted the focus-event example; (D) CSP silently blocks injected scripts; (D) the fixed result key returned stale results; (D) undersold decision points. (P) shipped text not reviewable; (P) extension/native-messaging alternative not discussed. *Resolved:* main-world key per call plus did-not-run message, verified live against a `script-src 'none'` page; alternatives section; decision table.
- **R2 (clean-door):** (D) guard actions invisible to the operator; (D) active-tab targeting with no origin check. (P) async results, minor TOCTOU, a misleading error name. *Resolved:* origin argument; reporting rule; sync-only note; error renamed.
- **R3 (clean-door):** declined to continue, on the presence-faking and multi-account promotion use. *Resolved:* removed from the shipped skill (spec item 5).
- **R3 (internal):** (D) registry 503 on the fleet; (D) a missing id became an empty profile; (D) an absolute path could reach the operator's Chrome; (D) Codex agents lacked the rules; (D) page text unmarked; (D) two-event origin race. (P) ask-first unrecorded; numbering; atomic write. *Resolved:* all.
- **R4 (internal):** (D, high) jail escape via `..` with `--new`; (D) the skill still taught synthetic events as a first step. *Resolved:* realpath canonicalization; wording; tests for both escapes.
- **R4 (clean-door):** (D) "invariant" overstated an instruction. (P) operator window race; `(nil)` overloaded; home-equal-path; glossary. *Resolved:* row relabelled; page-state rule; recovery rows; `?*` pattern.
- **R5 (internal):** (D, low) ids not held to the registry rule (prefix match with spaces); (D, low) the jail admitted any folder in the home. *(clean-door)* exit codes parsed from stdout; jail is accident prevention; no activity trail. *Resolved:* id regex, whitespace refusal, reserved folders, exit-code map, activity line, honest jail wording.
- **R6 (internal):** (D) the main-world hash covered the random wrapper. *(clean-door)* best-effort log overstated; in-band ERR; launch drops the url silently; denylist instead of allowlist. *Resolved:* caller hash via `NC_CALLER_*`; allowlist; resolved-path whitespace check; "already running" message; relative profile path; visible test skips.
- **R7 (clean-door):** (D) a trailing `//` comment swallowed the result write; (D) a page could steer exit codes with `ERR` text. *(internal: zero design.)* *Resolved:* newline after caller code; nonce envelope in the isolated world; verified live.
- **R8:** zero design from both. Precision: stale item 7 text, page-level `let R` collision (function scope added), Promise/newline note, home-with-spaces message, JXA alternative, glossary, capability sentence.
- **R9:** zero design from both. Precision: `let R`/`return` guidance, missing recovery rows, two tests, activity-line ordering, operator-decides line in the CLAUDE.md section, main-world output is page-claimed data.

## Convergence verdict

Converged at round 9. Rounds 8 and 9 had no design-class findings from either reviewer, and no open questions remain. The only cross-family reviewer (codex) failed in every round, so this converged without a genuine non-Claude opinion; the banner above says so.
