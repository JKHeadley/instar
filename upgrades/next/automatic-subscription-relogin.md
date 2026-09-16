# Upgrade Guide — vNEXT

<!-- bump: patch -->

## What Changed

Subscription sign-in repair now supports both Claude Code and Codex. The browser worker submits each login form atomically, can choose “Continue with Google,” and handles OpenAI's public device-code flow without routing it through Claude's paste-back controller.

An explicit unattended policy removes the recurring dashboard approval for named subscription emails. It remains bounded to the exact account, provider, framework, machine, dedicated browser profile, and open corroborated incident. Wrong identity, unexpected origin, CAPTCHA, phone confirmation, and permission expansion still stop the flow.

## What to Tell Your User

Once each account has a dedicated pre-signed-in Google profile and is explicitly allowlisted, Claude Code and Codex can sign themselves back in after ordinary expirations. You no longer need to keep tapping Repair sign-in. Genuine provider security challenges still pause and ask you instead of being bypassed.

## Summary of New Capabilities

- No-click re-authentication for explicitly allowlisted Claude Code and Codex identities.
- Native OpenAI/Codex device-code entry and Google account selection.
- Accurate audit events distinguish unattended policy approval from human approval.
- Fleet defaults stay off, dry-run-first, and approval-gated.

## Evidence

- Unit, integration, real-Chrome, and AgentServer lifecycle coverage for exact-path admission, form submission, Google selection, Codex device codes, no-click execution, audit semantics, configuration migration, and refusal boundaries.
