<!-- bump: patch -->
<!-- internal-only -->

## What Changed

Added a dark runtime option for a single reserved Telegram start during a Lifeline restart. It preserves the shared per-account bound and retries the existing operation while the machine holds the lease.

## Evidence

Focused runtime tests cover explicit refusal, socket shutdown, automatic recovery of the original operation, replacement listener startup and the combined rate bound.
