# Telegram History Backfill — ELI16 Companion

**Who this is for:** Justin (and any operator reading this for the first time)
**Reads in:** ~3 minutes
**Companion to:** TELEGRAM-HISTORY-BACKFILL-SPEC.md (technical)

---

## The story in one paragraph

Earlier today my local message store got wiped during a recovery — the database that held our conversation history was reset to nearly empty (four messages on the lockdown topic, where there used to be dozens). The reason it can't just be re-fetched: Telegram's bot API is forward-only. Bots only see messages that arrive while they're listening; they cannot reach back into history. Your Telegram app shows the full thread because your account has authority over its own history — my bot does not. So I built a small recovery tool that signs in **as your account** (one-time, with your phone + an SMS code), reads the missing history, and writes it back into my local store with strict guardrails: read-only on the Telegram side, no sends, no edits, no deletes, and the writes are de-duplicated so re-running it never creates copies.

---

## What this is and isn't

**What it is:** a one-shot backfill script. You auth once. I read the missing messages. They land in my store. Done. The next time my bot polls Telegram for new messages, it picks up where the backfill left off automatically.

**What it isn't:** a long-running listener under your account. Real-time messages still come in through the regular bot path. The user-account session is purely a recovery primitive — used when needed, dormant otherwise.

---

## The three pieces

1. **A small library that talks to Telegram as your account.** It can list every topic in our lifeline supergroup, then walk through each topic message-by-message. It cannot send, edit, or delete anything. Adding those abilities would require explicit new approval from you.

2. **A small library that writes into my message store.** It's idempotent — if you run the backfill twice, the second run inserts zero new rows and skips the ones already there. This matters because the actual backfill might get interrupted (network blip, Telegram rate-limit cool-off) and need to resume. Resuming is just running it again.

3. **A command-line entry point** that ties them together with three modes: `--auth` to set up the session once, `--chat <id>` to back up an entire supergroup, and `--chat <id> --topic <id>` to back up just one topic.

---

## Where your credentials live

You gave me an api id and an api hash. Both are stored in a sealed local file in my home directory:
- The folder is set to mode 0700 (only my user can list it).
- The credential file is set to mode 0600 (only my user can read it).
- Both live OUTSIDE the agent's git tree, so the auto-sync that pushes my state to a git remote cannot accidentally publish them.
- There's a "MIGRATE TO BITWARDEN" marker at the top of the file. When you next unlock Bitwarden and tell me, I'll move them in.

The **session string** that gets created after you auth lives next to the credentials file, also at mode 0600. The session string is the thing that lets me skip the SMS-code dance on every run — it's the long-lived credential. If anything ever goes wrong, Telegram → Settings → Devices → Terminate the suspicious session, and the string instantly becomes useless.

---

## What I need from you

**One message, just your phone number.** Country code + digits, nothing else. As soon as that lands I trigger the auth flow. Telegram sends you an SMS code. You paste the code back. If you have 2FA enabled, you paste the 2FA password back. Then I'm authed — and from there everything runs autonomously: list every topic, walk each one, write into the store, report counts.

Estimated time on your end: 60–90 seconds total across two replies.

---

## What runs after I'm authed

1. I list every forum topic in our lifeline supergroup.
2. For each topic, I iterate every message from oldest to newest.
3. I batch them in groups of 200 and write each batch into the store inside a single transaction.
4. If Telegram rate-limits me with a "wait N seconds" response (FloodWait), gramjs handles the backoff and I resume.
5. When all topics are done, I print a summary: number of topics touched, total messages fetched, total inserted, total skipped (the dedup count).

For our specific case, the lockdown topic has 4 messages on disk right now and probably 30-50 in the real thread. Other topics likely have similar small-vs-real gaps.

---

## What this PR doesn't try to do (and why)

- **Real-time tailing.** The bot polling already handles live messages. A user-account listener would duplicate that work without clear gain. Out of scope.
- **Promotion to a full instar feature.** I deliberately wrote this as a script in `scripts/` rather than as `src/messaging/TelegramHistorian.ts`. The script tier ships fast, recovers the data, and proves the design. Promotion to a real feature (CLI subcommand, HTTP route, three-tier tests, agent-template update) is a separate, follow-up PR once we've confirmed the recovery actually works.
- **Bitwarden integration this round.** Bitwarden was locked when you handed me the credentials. The script accepts a credential-file path argument so the storage location is decoupled from the format — once Bitwarden is the source, we just point the script at a different path.

---

## The single thing to remember

**Auth happens once. After that, every run is non-interactive.** The session string is the magic. As long as Telegram trusts that string, I can re-run the backfill any time you want without bothering you for codes.

If you ever want to revoke my access entirely, your Telegram Settings → Devices page is the kill switch. That's the same way you'd kick out any third-party Telegram client.
