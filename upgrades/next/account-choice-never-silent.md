# Setup never picks an AI account on its own

<!-- bump: patch -->

## What Changed

The installer's account-choice step (`src/install/accountChoice.ts`) had a compatibility fallback: when an install was resumed while waiting at `do-account-choice` and the answers file carried no `account` field, it treated the caller as an app from before the question existed and silently used the default config folder (`~/.claude` or `~/.codex`) when it was signed in. That claimed an account the person never chose. It now asks again (`awaiting-person` with the same account cards) and its instruction says to update the Instar app if no choice appears. An answer on resume still completes the step as before. The spec `create-agent-accounts-and-always-on.md` §A.2 is amended to match.

## What to Tell Your User

- **Setup always asks which account**: "When you create an agent and you're already signed in to Claude or ChatGPT on this computer, setup now always asks which account to use. It never quietly picks one for you, even if you're using an older version of the app."

## Summary of New Capabilities

| Capability | How to Use |
|-----------|-----------|
| The account choice is never skipped on resume | Automatic |

## Evidence

- `tests/unit/install-account-choice.test.ts`: the old test that expected the silent default is replaced by one that fails on main. For both Claude and ChatGPT, a resume without an answer stays at the step with every account card and the update-the-app instruction, and does not fall through to sign-in with only a non-default account. A second test checks that a resume with an answer still completes. 12/12 pass; neighbouring `install-flow` and `install-accounts` tests pass (54/54).
