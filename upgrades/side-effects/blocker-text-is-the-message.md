# Side-effects review: blocker entries record the message, not the shell command

## Change
- `src/core/PostUpdateMigrator.ts` (deferral-detector hook template): `blockerTextOf(command)` takes the heredoc body of a reply command and masks credential-looking query values (`sig`, `signature`, `token`, `key`, `auth`, `access_token`); the auto-opened blocker posts that instead of the whole command. With several heredocs it takes the one whose header line invokes the reply/send script.
- Same hook: a command counts as a message only when the reply/send script appears OUTSIDE heredoc bodies (`withoutHeredocBodies`). A command that writes a file whose text mentions the script (code, docs, tests) is no longer treated as a message; on 2026-11-02 two such code-writing commands opened new "Just spotted" rows within minutes.
- `dashboard/console/plans-model.js`: `blockerText()` applies the same reading to stored rows (first non-empty line, masked, capped at 220 chars); a command with no message text reads "Flagged in a command I ran (no message text)".

## Evidence
On the Studio (2026-11-02) all 50 `/blockers` entries were `candidate` rows from `deferral-detector` whose `detectedText` began `cat <<'EOF' | .claude/scripts/telegram-reply.sh <topic>`; the console Plans page printed them verbatim, including a private-view link with its `sig=` value.

## 1. Over-block
None added. The comm check is narrower, so fewer commands are checked at all.

## 2. Under-block
A message sent from inside a script that is itself a heredoc (e.g. `python3 - <<EOF` calling the reply script) is no longer checked by this hook; the outbound tone gate still reviews every message that is actually sent.
A credential not in a query parameter is not masked here; the outbound credential wall still governs what is sent. Stored rows keep their raw text in the ledger; only the display is cleaned.

## 3. Level-of-abstraction fit
The producer records the right thing; the display handles rows written before.

## 4. Signal vs authority
The hook stays signal-only (it never blocks). No authority added.

## 5. Interactions
None with the tone gate or the blocker state machine; only the stored text changes.

## 6. External surfaces
Dashboard Plans "In the way" rows read as sentences. Built-in hook, always overwritten on update (Migration Parity).

## 6b. Operator-surface quality (Operator-Surface Quality standard)

Plans "In the way" rows now lead with the plain sentence the agent wrote (first line, capped at 220 chars) instead of shell wrapping; no raw command, topic number or link signature is shown. A row with no message reads "Flagged in a command I ran (no message text)" rather than the command. Layout and actions are unchanged; checked on a 390px-wide phone view in the existing console tests' row model.

## 7. Multi-machine posture
Machine-local ledger, unchanged.

## 8. Rollback cost
Revert.
