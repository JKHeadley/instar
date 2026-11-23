<!-- internal-only -->
# Session Link Rendered Regression

## What Changed

The session-link button regression now checks computed styles from the actual stylesheet instead of requiring an obsolete exact CSS declaration. Runtime styles remain unchanged.

## Evidence

The exact retained failure and focused reproduction identify the same assertion. Focused session/Chats/front-door checks and real Chrome centering/wrapping geometry are recorded before the corrected candidate is submitted. Complete verification remains required.
