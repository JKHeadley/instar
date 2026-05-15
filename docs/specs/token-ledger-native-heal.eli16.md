# Token Ledger Native-Module Heal — ELI16 overview

## The short version

Every instar agent keeps a small token-usage ledger so it can show you, in the Dashboard, where your AI calls are going. The ledger lives in a SQLite file. SQLite in Node is loaded via a small native binary that was compiled against a specific Node version. When Node gets upgraded after instar was installed (which happens a lot on the developer's machines), the native binary doesn't match anymore and the ledger refuses to open. The agent then runs forever with the ledger off — the API returns "ledger unavailable", the Dashboard tab shows nothing, and anything that depends on knowing where the tokens are going is blind.

We've actually had a fix for this exact problem in tree for a while: there's a small helper called `NativeModuleHealer` that, when it sees the version-mismatch error, runs `npm rebuild` automatically and retries. The catch: the helper's public surface is async (returns a Promise), and the TokenLedger's constructor is synchronous. So even though the fix exists, the ledger wasn't using it — and the ledger has been silently down for two days on this machine.

## What this change does

Two pieces.

1. A new sync variant of the healer's main entry point. Same behavior — catch the mismatch error, rebuild the native binary, retry once — just exposed through a sync-friendly surface so a sync caller can use it without having to be made async. The healer's internals were already entirely sync (it shells out via `spawnSync` and logs with `fs.appendFileSync`); this just removes the gratuitous async decoration for sync callers.

2. The token ledger's constructor now opens its SQLite file *through* that sync surface. Same code path on the happy case — open the database, set pragmas, create tables. Different path on the rare ABI-mismatch case — the healer catches the throw, runs the rebuild, and retries. The agent's state directory gets configured into the healer beforehand so heal events log to a known location (`.instar/native-module-heals.jsonl`) instead of the system tmp.

## Why it's safe

The healer code itself isn't new — it's been running in tree for weeks healing the memory subsystem (SemanticMemory, TopicMemory, MemoryIndex). We're just consuming it from one more place. The existing rebuild-at-most-once-per-process guard prevents pathological loops if the rebuild keeps failing.

If anything goes wrong, the worst-case is that the token ledger comes up as `null` (same as before this fix) and the `/tokens/*` endpoints return `{"error":"token ledger unavailable"}` — the exact behavior we have today. So the fix is strictly equal-or-better than the current state: in the common case (correct binding), nothing changes; in the broken case (mismatched binding), the healer kicks in instead of giving up.

## Why it matters

The token ledger is the foundation for any "where are my tokens going" question. Today's PromptGate fix landed because I was able to read JSONLs by hand — but the *whole point* of the ledger is that I shouldn't have to. With the ledger working, future bleeding patterns will be visible the moment they appear, the Dashboard tab will populate, and the upcoming "auto-detect bleeding + alert" system will have a live data source instead of a stale ledger DB.

## What you'd see if it goes wrong

Probably nothing — the worst case degrades to today's broken state. Best case: the next time you ask the agent to show you token usage, the data is actually there. The rollback is a four-file revert with no migration cost.

## How we know it works

Six new regression tests pin the sync surface's behavior (success / non-mismatch passthrough / heal failure / heal then retry / no-retry-after-prior-failure / TokenLedger routes through the healer). All 49 healer + ledger tests pass clean. The acceptance criterion is the obvious one: after this ships and Echo (plus the other agents) upgrades, `/tokens/summary` returns live data instead of the unavailable error.
