# Agent-Health Lane — Raw-Tag Formatting Fix — Plain-English Overview

> The one-line version: the "🩺 Agent Health" lane was showing raw `<b>...</b>` tags instead of bold, because its notice was sent without telling Telegram to render HTML — this one-line fix passes the HTML flag, exactly like the lane's own intro and the attention hub already do.

## The problem in one breath

When the agent drops a heads-up into its calm "🩺 Agent Health" Telegram topic (for example "Inbound stranded on <machine>"), the notice is built with a bold title (`<b>...</b>`), but it was sent down a path that didn't tell Telegram to interpret HTML. So instead of a bold title, the user literally saw the `<b>` and `</b>` characters in the message. It's a cosmetic bug that made a calm housekeeping notice look broken.

## What already exists

- **The agent-health lane** — one calm, shared "🩺 Agent Health" Telegram topic where the agent posts low-key notices about its OWN sessions (a session that looks stuck, a machine it briefly can't reach). It is meant to be quiet and browsable.
- **`sendToTopic(..., { formatMode: 'html' })`** — the existing, correct way to send a message that already contains Telegram HTML so the tags render as formatting instead of being re-escaped into literal text. The lane's own intro post and the attention-hub post already use it. This exact fix was applied to the attention hub on 2026-07-11 for the identical bug class.

## What this adds

Nothing new — one call site is corrected. `TelegramAdapter.routeToAgentHealthLane` builds a `<b>title</b>` line and was calling `sendToTopic(topicId, line)` with no format mode, so the markdown converter re-escaped the tags. It now calls `sendToTopic(topicId, line, { formatMode: 'html' })`, so the title renders as bold. There is no new module, no new decision point, no new authority.

## The new pieces

None. This is a one-line correction plus a regression test.

## The safeguards

**Prevents the raw-tag rendering from coming back.** A unit test raises an agent-health-lane item and asserts the outgoing Telegram send carries `parse_mode: HTML` + `_formatMode: html`. If the `formatMode` flag is ever dropped again, that test fails.

**No behavior change beyond formatting.** The fix only affects how the already-authored HTML is transmitted. It does not change what is posted, when it is posted, how notices are de-duplicated, or any routing/blocking decision. The send path even has a built-in fallback: on a rare malformed-HTML 400, it retries as plain text so the message still delivers.

## What ships when

This one-line formatting fix ships on its own, immediately.

**Note — the separate flood fix is a tracked follow-up, not in this PR** <!-- tracked: CMT-854 -->. The "🩺 Agent Health" lane also had a *flood* problem (the same "Inbound stranded" notice reposting repeatedly). Fixing that turned out to be more than a small change: a naive "make the de-dup key stable" fix would stop the flood but, because the underlying attention store never clears or expires a stranded notice, it would silently go blind to a genuinely new strand later — trading a loud flood for a quiet, worse failure on a reachability-critical signal. That fix needs a proper signal-lifecycle design (clear-the-alert-when-the-machine-recovers, restart-robust) and is being taken through the spec process separately <!-- tracked: CMT-854 -->. Until it ships, the flood stays suppressed by the existing stopgap (the stranded-topic sentinel is disabled in this agent's config).
