# Codex sessions start on an account with room (plain overview)

## What happened

An Instar agent can hold several Codex accounts. Each account has a weekly allowance and a five-hour allowance. When an allowance is used up, Codex refuses work until a reset time.

On 12 November 2026 the agent on the Mama PC started five background Codex sessions. All five started on the same account, `codex-sagemindai`, which the agent's own account list already showed at 100% of its weekly allowance, resetting on 14 November. Each session died within seconds with "You've hit your usage limit". Three other Codex accounts on the same machine were at 30, 34 and 62%.

## Why it happened

The agent already has a rule: a new session never starts on an account the pool knows is out of allowance. That rule was only wired for Claude sessions. When a background session was started for Codex, the code asked the account pool for an account only if the session was a Claude one. A Codex session skipped the question and used whatever Codex login was the machine's default. Nothing compared that login with the usage readings, and the session was not labelled with any account, so later tools could not say which account it died on.

## What changes

- A new background Codex session now asks the pool first. It starts on the Codex account with the most room and is labelled with that account.
- An account counts as "out" while its weekly or five-hour reading is at 100% or more, until that reading's reset time. This is the same test the existing rescue code already uses for sessions that hit the limit mid-work.
- If every Codex account is out, the session is not started. The caller gets a clear refusal that names the soonest reset time, instead of a session that dies at once.
- The record of how a session ended now names the account it ran on.

## What stays the same

- An agent with no Codex accounts in its pool behaves exactly as before.
- The operator's existing switches still turn this off.
- A caller that names a specific account still gets that account.
- Claude sessions and interactive sessions are not touched.

## Not in this change

Three related problems are tracked separately: the manual "swap this session" request refuses sessions that are not tied to a Telegram topic; the automatic rescue does not move background sessions that hit the limit mid-work; and the rescue's choice of target is not always the account with the most room.

## What a reader needs to decide

Nothing. This is a narrow bug fix that makes the existing rule apply to Codex background sessions. Reverting the change restores the old behaviour.
