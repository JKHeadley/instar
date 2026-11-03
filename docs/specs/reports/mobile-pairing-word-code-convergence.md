# Convergence Report — The phone-pairing confirmation code becomes a word plus four digits

## Cross-model review: codex-cli:gpt-6-astra

The external pass ran in all three rounds through the Codex CLI on the codex-followme-sagemindai account, read-only, model gpt-6-astra. It was run by hand because the skill script's default model (gpt-5.5) is not usable here. Round 1 and round 2 found design problems. Round 3 returned "converged".

## ELI10 Overview

When you add an agent to the Instar iPhone app, you type a short confirmation code that only you can see: in your private Telegram chat, or on the dashboard after you unlock it with your PIN. The code used to be six digits, and so is the PIN. On 2 November the operator typed the PIN where the code belonged and got stuck.

This change lets new app builds ask for a code shaped like `KITE-4172`: a word from a fixed list of 256, then four digits. It cannot be mistaken for a PIN. If someone does type a PIN, or anything else that is not a word plus four digits, the app is told "that is not the pairing code" and it does not count as a wrong guess, because it could never have been right. Older app builds keep getting six digits.

Nothing else about pairing changes: who approves, where the code is shown, the guess limits, and the rule that the agent never asks for the code. Guessing is no easier and no harder than before, because whoever starts a pairing can still ask for the six-digit kind.

## Original vs Converged

- **A typed PIN no longer costs a guess.** Originally a wrong-shaped entry on a word-code phone still cost one of the three allowed wrong guesses, which is exactly the operator's 2 November mistake. Now it gets a plain `wrong-format` hint and costs nothing.
- **The leak scan can no longer be pushed past a real code.** Originally the scan looked at only the first 50 word-plus-number pairs in a message, so a long message could hide a pasted code. Now it checks only words on the 256-word list, with no cap, and the work stays small.
- **The scan sees every form the server accepts.** Originally the server accepted spacings (like `K I T E 4172`) that the scan could not catch. Now one shared definition of "a word code" is used by both, and spaced-out letters are refused.
- **The security claim is honest.** Originally the spec said guessing got harder. It does not, because the requester picks the format; the spec now says "no weaker than today".
- **Stated facts were corrected.** Guess limits are per machine, not agent-wide. Pending device records and wrong-guess fingerprints are on disk (as today); only the live code and its fingerprint table stay in memory.
- **The CLAUDE.md update reaches existing agents.** Originally the update was placed inside an older migration step that already-updated agents never run, and it changed only one of four sentences that say "6-digit". Now it is a separate, idempotent check covering all four sentences.
- **Missing pieces were added:** the classified decision-point table, open questions (none), frontloaded decisions (word list review, response shapes, input bounds, the app-side dependency), the multi-machine justification line, and honest test wording.

## Iteration Summary

| Iteration | Reviewers who flagged design | Design findings | Left behind | Spec changes |
|-----------|------------------------------|-----------------|-------------|--------------|
| 1 | security, adversarial, integration, decision-completeness, lessons-aware, codex | 11 (deduplicated ~9) | 8 | wrong-format/no strike; uncapped word-gated scan with a shared form definition; honest security claim; separate migration covering four lines; machine-local justification; corrected persistence and per-machine budget claims; decision table, open questions, frontloaded decisions; P20 section; test wording |
| 2 | decision-completeness, codex | 2 | 10 | wrong-guess HMACs on disk stated; app-side dependency named (Frontloaded Decision 5); plus precision folds (ASCII-only letters, migration sniff needs `6-digit`, shared pattern fragment, dashboard row shape) |
| 3 | (none) | 0 | 7 | one-line precision folds only |

Standards-Conformance Gate: round 1 ran (2 flags: multi-machine posture without a justification key; "existing tests prove" overclaim). Round 2 ran (1 flag: the justification key contested). Round 3 ran (1 flag: the same contest). The remaining flag is judged out of scope below.

Internal reviewer model: claude-opus-5-5 subagents, all three rounds. In rounds 2 and 3 the six lenses were grouped into three and two subagents.

## Proportion

Tier 2 (auth-adjacent), spec of about 120 lines. Three rounds used of a six-round cap.

## Left behind

- The constitution gate keeps flagging `physical-credential-locality` for pending pairing codes as describing the implementation rather than a physical constraint. This slice does not change posture, and it uses the same key for the same object as the mobile-native-conversations precedent. Two reviewers judged it a pre-existing posture outside this slice. If the posture is revisited, that belongs on CMT-1252.
- Separators outside the accepted class (for example spelled-out digits) are not caught by the scan. They are also refused by `check()`, so a phone cannot confirm with them.
- The word list contents are reviewed once in the PR (Frontloaded Decision 1); a unit test cannot judge offensiveness beyond the denylist.
- Codex round 3: the rate-limit reference named the wrong function. Fixed in passing (now `deviceRateOk`).
- Round 3: a non-string `code` on a word device is `wrong-format`; the format is stored in the same entry as the HMAC; a digit on the scan's left boundary still matches. All fixed in passing.
- Round 3: the migration names each opening-line prefix and keeps the unrelated `6-digit PIN` dashboard line untouched. Fixed in passing.
- Round 1: a claimed gap that the leak scan watches only Telegram was checked against the code and rejected. The scan is already wired to Telegram, app conversations and app-sent Slack.

## Full Findings Catalog

### Round 1
- [DESIGN, security/codex] The 50-candidate cap on the word scan fails open. → Gate candidates on the 256-word Set and remove the cap.
- [DESIGN, security] "The code space grows" is false against an attacker who picks digits. → Reworded to "no weaker than today".
- [DESIGN, adversarial/decision-completeness] A typed PIN still costs a strike. → `wrong-format` with no strike on word devices.
- [DESIGN, codex] The scan misses forms that `normalizeCode` accepts. → One shared form definition; spaced-out letters refused.
- [DESIGN, codex] The budget was described as agent-wide; it is per machine. → Corrected.
- [DESIGN, codex] Persistence and plaintext claims were wrong. → Corrected.
- [DESIGN, integration/codex] The migration would not reach updated agents and covered only one of four lines. → A separate content-sniffed check over four lines.
- [DESIGN, integration] No machine-local justification line. → Added.
- [DESIGN, integration] "Existing tests stay green unmodified" was false. → Reworded, and a digits regression test added.
- [PRECISION ×8] Decision table and open-questions format, word-list ownership, response shapes, codeFormats bounds, P20 declarations, new-agent coverage, the prettyCode source, separator gaps. Folded in.

### Round 2
- [DESIGN, codex] "The HMAC is never on disk" is false (wrong-guess HMACs persist, possibly including another pending device's code). → Stated honestly.
- [DESIGN, decision-completeness] The app side had no named owner. → Frontloaded Decision 5.
- [PRECISION ×10] Distinct-strike wording, ASCII-only letters, shared fragment, upstream size bound, the dashboard digits-row shape change, a wrong-format table row, the rate-limit dependency, the migration sniff rule, a composition test, the multi-machine reason, the rollback in-flight case. Folded in.

### Round 3
- No design findings from any reviewer, including codex ("VERDICT: converged").
- [PRECISION ×7] Listed in Left behind.

## Convergence verdict

Converged at round 3. The final round found nothing that changes what gets built, and seven small items were folded in or left behind. The spec is ready for approval.
