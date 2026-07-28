# Convergence Report — Remote Session Close

## ELI10 Overview

This is the close button (×) for sessions running on your OTHER machines — the missing half of the "one dashboard" goal. You can already click any machine's session and watch its terminal from anywhere; after this, closing one works the same way: your machine passes the request to the machine that owns the session, over the same authenticated connection the machines already use, and that machine does the close. Closing five stale Mac Mini sessions this week took hand-typed commands; after this it's five clicks.

The main tradeoff is that a remote close is destructive at a distance, so the design spends most of its weight on containment: it can only ever target the exact session you clicked (by unique id), it can never send your machines' credentials to an unverified address, it can't be looped into a mass-kill, and both machines keep a record — the owner logs the close, yours logs the order.

## Original vs Converged

The review changed this design more fundamentally than any other this week — including catching the author (me) in a false safety claim:

- **The "guards will refuse" claim was false, and the review proved it.** The original draft said protected sessions would refuse a remote close because "all the safety checks run on the owning machine." Two reviewers independently verified in code that an operator-initiated close deliberately BYPASSES those guards — they exist to stop the system's own automatic cleanup, not the operator. The converged design is honest: a remote close, like the local one, WILL close a protected session — and the real safety is informed consent: the dashboard now tells you a session is protected and which machine it's on before you confirm. (This finding also corrected a same-day misstatement I'd made to the operator about manual closes — reported and corrected separately.)
- **A wrong-machine kill was possible in the original; the converged design makes it impossible by construction.** The original rode a query flag on the existing close route — which an older server would ignore, closing a same-named LOCAL session instead (session names genuinely recur across machines briefly after transfers). The converged design uses a brand-new route old servers genuinely don't have, and targets the session's unique id rather than its name (which also makes it safe against the duplicate-record corruption fixed earlier today).
- **Credential protection went from unstated to mandatory.** The relay attaches the machines' shared key to a peer address from the registry; the converged design requires the same address-allowlist check the guard-posture design made mandatory — a stale or poisoned address is rejected by name, never sent the key.
- **Honesty rules for a destructive action at a distance:** a timeout now reports "outcome unknown — refreshing" (the close may have landed; claiming "nothing happened" would be a fake failure); a second click on an already-closing session reads "already closed," not a scary error; non-JSON tunnel errors are normalized so the real reason reaches your screen; and the relayed origin note in the owner's log is recorded as an unverified claim, never trusted for any decision.
- **The protected-session warning required new plumbing the original assumed existed** — session records didn't carry a "protected" flag at all; the converged design ships it as a named additive field, with honest "protection status unknown" rendering for machines not yet updated.

## Iteration Summary

| Iteration | Reviewers who flagged | Material findings | Spec changes |
|-----------|-----------------------|-------------------|--------------|
| 1 | security, adversarial+lessons, integration+scalability, GPT, Gemini | ~20 (1 critical) | Authority section rewritten to code-truth; distinct 404-true route; UUID targeting; URL allowlist dependency; rate limit; relay-side audit; delivery-honest UX; agent-awareness + migration |
| 2 | combined-lens internal, GPT | 1 | `protected` flag named as a shipping dependency with skew handling; param-convention + AC phrasing fixes |
| 3 | combined-lens internal | 0 (converged) | cosmetic param harmonization folded post-verdict |

External-model disclosure: GPT-family (codex-cli, gpt-5.5) ran rounds 1–2; Gemini (gemini-2.5-pro) completed round 1; Grok-family unavailable on this machine.

## Full Findings Catalog

Key reviewer-attributed findings with resolutions (full texts preserved in the session transcript):
- Adversarial/Security R1 (CRITICAL + HIGH): operator-origin bypass disproves the refusal claim → §2.0 honest authority + informed-consent confirm; forgeable origin header → untrusted `viaClaim`, never in authority decisions.
- Integration R1 (HIGH): query-param rollback claim factually wrong → distinct `POST /sessions/:name/remote-close`; URL-allowlist shipping dependency adopted.
- Adversarial R1 (HIGH): ghost-record + stale-tile lessons → UUID targeting + calm already-closed UX + delivery-honest timeout.
- Adversarial R1 (MED): kill-amplifier → rate limit + relay-side order audit + explicit no-bulk non-goal.
- Combined R2 (MAT): `protected` flag doesn't exist on records → named additive shipping dependency + skew rendering.

## Convergence verdict

Converged at iteration 3. No material findings in the final round; every load-bearing claim spot-checked against the codebase by the final reviewer. Spec is ready for user review and approval.
