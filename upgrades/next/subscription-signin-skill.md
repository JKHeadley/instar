# Upgrade Guide — vNEXT

<!-- bump: patch -->

## What Changed

New built-in skill `/subscription-signin` (`src/data/builtinSkillContent.ts` → `SUBSCRIPTION_SIGNIN_SKILL_CONTENT`, registered in `installBuiltinSkills`): the one standard procedure for keeping Claude Code and Codex subscriptions signed in, written from what has been proven on real accounts. It covers the chain (a Google-signed-in Chrome profile per account per machine → sign-ins only in a normal, never automated, browser → Instar-started CLI login → measured success), the hard rules (no automated browser on sign-in pages, no CAPTCHA/phone work-arounds, never another account, no secrets in chat/files/command lines, no cross-machine profile or login copies, never touch a Chrome window it did not open), setup once per account per machine, what to read and do when an account needs sign-in (built-in repair first), a failure table with the concrete action for each outcome seen live, and the small set of habits that prevent most failures. New skill ⇒ installed on existing agents by the normal non-destructive skill install on update; a CLAUDE.md awareness bullet is added for new agents and patched in idempotently for existing ones.

## What to Tell Your User

Every agent now carries the same written procedure for keeping its Claude and Codex sign-ins working: which browser profile each account uses, how the automatic repair signs them back in through a normal browser, how to check it worked, and exactly when it will ask you for help instead of guessing.

## Summary of New Capabilities

- `/subscription-signin` — the standard sign-in procedure for Claude Code and Codex subscriptions, shipped to every agent.

## Evidence

- Grounded in the 2026-09-24 live repair of justin@sagemindai.io on the Studio (normal Chrome, Authorize on first click, account `active`) and the failure classes observed that day (Authorize stall and Cloudflare hold under automation; `pending-login-already-live`; missing profile on a machine).
- Tests: `tests/unit/init-subscriptionSigninSkill.test.ts` (install, frontmatter, load-bearing rules, template escaping, never overwrites a local copy); `tests/unit/PostUpdateMigrator-assistedRelogin.test.ts` (+awareness bullet, idempotent).
