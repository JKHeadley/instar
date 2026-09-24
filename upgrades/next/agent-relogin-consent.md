# Upgrade Guide — vNEXT

<!-- bump: patch -->

## What Changed

Agent-navigated sign-in repair (`navigation: 'agent'`): the first live repair on 2026-09-24 reached Claude's authorize page (`claude.ai/oauth/authorize`, controls **Authorize / Decline / Switch account**, no account shown) and the model twice chose **Decline**, ending each attempt. `AGENT_BLOCKED_PHRASES` now also blocks `decline`, `deny`, `switch account` and `not you` — none ever moves a sign-in forward, and `switch account` changes identity — so on that page only **Authorize** is offered. The navigator's instructions now say a consent control is only offered after Instar checked the permissions, that the page may not show the account (Instar verifies it after sign-in), and to wait rather than click it twice. Each agent drive now logs one line with its outcome and its redacted step trail.

## What to Tell Your User

On a development agent, the automatic sign-in repair reached Claude's final "Authorize" page but sometimes pressed "Decline" there, because that page doesn't say which account is signed in. It no longer offers "Decline" or "Switch account" at all — the account is still checked by Instar right after sign-in.

## Summary of New Capabilities

- Agent-navigated sign-in repair completes Claude's authorize step instead of declining it.

## Evidence

- Live, Studio v1.3.1273, 2026-09-24 10:41–10:44 PDT: episode `d62a5bee` reached `/oauth/authorize` (scopes within `allowedScopes`); recorded decisions show `click:2` (Decline); a probe of the same page listed `1 Authorize`, `2 Decline`, `3 Switch account` with no identity.
- Tests: `tests/unit/agent-relogin-navigation.test.ts` (+1: the real authorize page offers only `click:1`; blocked-phrase cases extended).
