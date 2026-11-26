<!-- bump: patch -->
<!-- internal-only -->

## What Changed

The never-silent incident view now counts Telegram replies retained because credential send capacity is unavailable. The original operation remains in the existing retry queue.

## Evidence

The focused Telegram runtime test checks that a credential-capacity refusal records the exact operation and does not start the lease-specific retry timer.
