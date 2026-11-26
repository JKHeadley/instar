# Sign-in repair: no-tap for listed accounts, and failed repairs try again — Plain-English Overview

> The one-line version: accounts you said may be fixed without asking now really are, and a repair that failed tries again on its own a few times instead of sitting failed forever.

## The problem in one breath

When a Claude or Codex subscription gets signed out, Instar can sign it back in by itself. You told it which accounts it may fix without asking you first (echo@ among them). On the Macs, the newer "helper session" way of signing in ignored that list and always waited for your tap, so echo@'s repairs sat waiting all morning. Separately, a repair that failed (dawn@ on the Laptop since mid-September, justin@ on the Mini) just stayed failed, even though the account was still signed out. Nothing ever tried again unless you pressed a button.

## What already exists

- **The repair itself** — signs an account back in using that account's own browser profile, and counts as done only when Instar has checked the account really is the right one and really works.
- **The no-tap list** — the accounts you allowed to be repaired without asking, plus a "track record" bar an account must clear first (you set that bar to zero for Echo).
- **The helper session (Macs only)** — a short-lived agent session that does the clicking like a person would, run on a different healthy account, capped at 15 minutes.
- **Safety stops** — anything that looks wrong (a strange website, the wrong account, a CAPTCHA, extra permissions) stops the repair and is never retried automatically.

## What this adds

The helper-session path now follows the no-tap list exactly like the other paths do. An account on the list (that clears the bar) is repaired without a tap; an account not on the list still waits for your one tap, as before.

A repair that failed for an ordinary reason (it ran out of tries, it timed out, the helper did not finish) now tries again on its own while the account is still signed out: 6 hours later, then 24 hours apart, at most 3 times. For an account on the no-tap list it just runs. For any other account it re-offers the repair to you, which is the same "tap Repair sign-in once" message you already get. The dashboard shows when the next try will happen.

## The new pieces

- **Retry schedule** — a counter and a "next try" time on each repair. The counter is saved on disk, so a restart cannot reset it.
- **Leftover sign-in handling** — a failed try leaves its own half-finished sign-in waiting, which used to block any new try. A retry may now go ahead past that leftover (and replaces it, as every try does), but only if that same repair created it; a sign-in you started yourself still makes the retry wait.
- **Only ordinary failures retry** — running out of tries or time, or the helper not finishing. Anything else (a safety stop, a broken account record, a provider refusal, a lapsed approval) waits for you.

## The safeguards

**Safety stops stay final.** A repair Instar stopped for the wrong account, an unexpected website, extra permissions or a security check is never retried. The sign-in helper now reports when it hits a CAPTCHA, a phone check, the wrong account or a strange website; the repair then waits for you and is never retried on its own, and the next repair for that account waits for your tap until one succeeds. One honest limit: if the helper stops at such a screen without reporting it, that counts as an ordinary failure and is retried, at most 3 times. A repair you cancelled is never restarted without your tap.

**It never burns your last backup codes.** Accounts that sign in with one-time Google backup codes only run without a tap while enough codes are stored for a full try plus one spare (4 by default) — and never at all through the Mac sign-in helper, which cannot yet keep that count honest; there they always wait for your tap.

**You can stop it.** Tap cancel on a failed repair and it will not try again on its own. Messages about a failed try are held while another try is still coming (for up to about a day), and re-offers that need your tap, and the messages held for them, never arrive between 11 pm and 8 am.

**It cannot run away.** At most 3 extra tries per sign-in problem, hours apart. Before every retry, every existing check runs again from scratch: the account must still be signed out, the problem still open, and no other repair running. Each failed try, including retries, counts toward the "3 failures in a day" brake, the cap of 3 retries per problem applies on top, and any safety stop still trips the brake at once. A try that hit a CAPTCHA or phone check is never retried automatically, even if you resumed it. Instar's self-action limiter also watches every retry.

**Nothing new decides who can be repaired without asking.** That is still only your list plus the track-record bar. The helper still runs on a different account, only on sign-in pages, for at most 15 minutes, and success still means Instar itself verified the right account works.

## What ships when

One change: the helper path stops overriding the no-tap list, retries are added, the dashboard shows the next try, and agents' own instructions are updated (existing agents get the update automatically).

## What you actually need to decide

Nothing new: you approved this on 2026-10-14. To turn retries off, set `slowRetry.enabled` to false; to bring the tap back for an account, remove it from the no-tap list.
