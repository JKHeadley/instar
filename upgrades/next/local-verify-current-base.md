## What Changed

- **local-verify tests a PR's merge with the base branch's current head.** It used the PR's `baseRefOid`, which GitHub reports as the base at the PR's last update and which is days old for older PRs. It now reads the current head (`gh api repos/{repo}/branches/{base}`) when a verify is requested and refuses the request if that read fails.

## What to Tell Your User

Nothing changes for you. A fix to the still-off local test checker so a pass means "safe against today's main", not "safe against an old one".

## Summary of New Capabilities

- None (fix to an off-by-default feature).

## Evidence

- `tests/unit/localVerify/LocalVerifyService.test.ts`
