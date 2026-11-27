# Convergence report: recovery through the private chat (piece 3d)

**Spec:** `docs/specs/identity-security-piece3d-approver-recovery.md`
**Iterations:** 5. Four internal rounds (the internal reviewer converged at round 4), the constitution check twice, and GPT-6.2 Astra twice (Headley Codex account).

## In plain words

If you lose every phone that can approve, you start a recovery from your private chat with a code shown on your new phone. Then nothing happens for 72 hours, and you get three messages plus pushes to your devices. Any device that can still approve stops it just by approving something. After the wait you finish on the new phone with a fresh code. Every one of your computers checks for itself that the wait really happened, and the new phone can't approve until all of them agree. After that, the lost devices are removed.

## Findings by round

| Round | Design findings | What changed |
|---|---|---|
| 1 | 6 internal + 9 Astra | The wait is measured on each machine's own clock from its first sight; held, not retired; the attesting key's revocation checked; retired keys can't Stop; only a signed Stop locks; the proof is signed after the first read; the key is provisional; the build guard |
| 2 | 4 | Nothing retired at Finish; a stop before settle retires the key; machines that joined later; push notices; decision facts in signed requests |
| 3 | 1 | The "stolen" marks dropped |
| 4 | 0 | Converged (precision: mixed-rollout retired list, test wording) |
| Astra 2 | 8 | Lost keys revoked per umbrella §4.5a, but only after settling plus a clean round; umbrella §9's notice schedule; the deadline from the wait's end; acceptances bound to the exact entry |

## What the design guarantees

- **No machine can mint an owner key by back-dating:** every other machine measures the wait itself.
- **Any sign of a living approver stops it,** and a stop anywhere before settling cancels the recovered key everywhere.
- **The recovered key approves nothing** until every computer has accepted it.

## Stated residual

Umbrella §9 and decision 3: someone who took over the owner's Telegram and went unnoticed by every device for 72 hours can complete a recovery, including revoking the lost devices.

## Left for later pieces

- the no-chat route (3b);
- the administrator reset;
- the level checks (piece 8);
- voiding standing permissions and sign-ins (pieces 4 and 5);
- binding to a disputed migrated owner identity (pieces 1 and 4);
- home hand-off;
- team members' approval rights.
