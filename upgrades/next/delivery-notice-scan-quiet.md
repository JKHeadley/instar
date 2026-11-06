# Keep historical reply-delivery scans quiet

## What Changed
Historical undelivered-reply scans now reconcile durable Attention records without posting per-reply notices to old topics or the Attention hub. Original local conversational session send failures retain their existing notice path. Background recovery retries and credential-holder reporting are also record-only. Accepted originals close their record locally at any delay without a legacy status post or a claim that a separate explanation was delivered. Old queued interruption notices are withheld from both local and forwarded replay, with uncertain receipts preserved. Jobs and callbacks without explicit live authority remain record-only. Feedback fb-f348f8e4-15f.

## What to Tell Your User
Old reply-delivery records no longer fill quiet topics with interruption notices. Their delivery status remains available in Attention.

## Summary of New Capabilities
None. This repairs background notice behavior without changing notification preferences or reply recovery.

## Evidence
PR #2819 characterization: real origin service sends no Telegram request with enforcing selectivity; observation and disabled settings still deliver. Burst regression: 151 records across 48 topics, replay after restart, no topic or hub sends. Runtime fixture verifies live-versus-scan producer custody. See upgrades/side-effects/delivery-notice-scan-quiet.md.
