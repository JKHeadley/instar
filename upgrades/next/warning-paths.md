## What Changed

Every console line that marks something as a warning now declares how the person acts on it, and `tests/unit/console-warning-paths.test.ts` fails a new warning that doesn't. Warning page headlines get "Ask the agent about this". `GET /mobile/health-issues` no longer uses a reporter's raw text as a title, and iMessage follows its present state instead of the 30-minute event window, with Remote Desktop as its action.

## What to Tell Your User

Every warning on the dashboard now has somewhere to go, at least a way to ask me about it. If iMessage is down it stays listed until it's fixed, and the screen says what fixes it. If you don't use iMessage, ask me and I'll turn it off.

## Summary of New Capabilities

`askLink` and `pageHead`'s built-in ask link in the console, and a checked floor for new warnings. New action screen `desktop` on the health answer.
