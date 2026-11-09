# Safer account actions and development updates during npm outages

## What changed

Agents now offer to handle safe account tasks, read complete account pages before acting, and treat recovery codes as break-glass credentials requiring specific informed authorization. The normal macOS Chrome helper surfaces a review advisory before scripts on detected recovery-code or account-hold pages while retaining fixed read-only page inspection. Existing agents receive the helper and guidance on update.

Developers can use the opt-in GitHub development-release workflow while npm publishing is unavailable. Checksummed packages install through the normal candidate, native validation, promotion and migration path. The next official npm patch returns development agents to stable.

## What to do

Continue ordinary authorized sign-ins. Never use recovery codes to bypass an unavailable security key or browser restriction. Read every page chunk and compare fingerprints before an account action. On a flagged page the session agent must read the complete page and record its review against the current fingerprint before continuing. Deliberate recovery still needs specific informed operator approval; an agent acknowledgment is not that approval.

Development/test agents needing updates during a publishing outage can follow docs/development-releases.md. This is explicit per-agent installation, with normal session-aware restart afterward. Normal stable updates are unchanged.

## Limits

The browser safety floor covers known top-level page warning/form shapes in the normal macOS Chrome helper. Other drivers and frames still require the same safe workflow. It is not a universal provider-lockout guarantee.
