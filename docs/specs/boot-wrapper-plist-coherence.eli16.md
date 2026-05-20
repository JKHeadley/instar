# Boot-wrapper / plist coherence — what this fix does (ELI16)

## What broke

On 2026-05-20, my agent "echo" went dark on Justin's machine. The reason
turned out to be a stack of small problems, but the one that actually
kept echo from coming back was this:

To start an agent, macOS launchd reads a "plist" file (a config file in
`~/Library/LaunchAgents/`). The plist tells launchd what command to
run. Our plist said: run a file called `instar-boot.js`.

But the `instar-boot.js` file was GONE. It had been deleted earlier by
our own setup code. So every time launchd tried to start the agent, it
exec'd a nonexistent path and gave up. The agent never started, so none
of the elaborate self-heal logic we'd built (rebuild native modules,
restart the server, etc.) ever ran — they ALL live INSIDE the agent
process, which never came up.

## Why the file was deleted

Our setup code picked the file extension (`.js` vs `.cjs`) based on
whether the project's `package.json` had `"type": "module"`. When that
flag was set, setup wrote `.cjs` and **deleted the `.js` file** to avoid
confusion.

The trap: if the plist was generated when `"type": "module"` WASN'T set
(extension = `.js`), and the package later GAINED that flag, the next
setup run would write `.cjs` and delete the `.js` the plist still
pointed at. Plist and file silently fell out of sync.

## What this PR does

**Always write `.cjs`.** No more reading `package.json`. No more
deleting the alt extension. The file `instar-boot.cjs` works in BOTH
type=module and type=commonjs projects, because `.cjs` is a hardcoded
override that tells Node "this is CommonJS regardless of context."

**The plist always points at `.cjs`.** Since the wrapper is always
`.cjs`, the plist is always `.cjs`. No more two-way coupling between
`package.json "type"` and the launchd entry point.

**For agents already in the wild** that have plists pointing at `.js`,
a migration regenerates their plist to point at `.cjs` on the next
instar update.

**Defense in depth:** even if some other code path causes a future
drift, the lifeline now verifies the wrapper file actually EXISTS on
disk (not just that the plist mentions a wrapper file) and regenerates
if missing.

**One more bug while we're here:** the listener-socket cleanup used to
unconditionally delete an existing socket file before binding. If
another live agent was actually using that socket (rare but possible),
we'd silently steal the path from it. Now we probe first: if a live
peer answers, surface the error; if it's a stale file, clean it up
and retry.

## What it doesn't do

- **It doesn't change anything about native-module healing** (rebuild
  `better-sqlite3` when Node upgrades break it). That infrastructure
  already exists and works correctly — but only when the agent
  successfully starts, which is what this PR fixes.
- **It doesn't change shutdown or restart logic** elsewhere in the
  agent. The fix is purely in the WRAPPER GENERATION + WRAPPER
  EXISTENCE check.

## How to know it worked

After this ships, the field failure mode that needed Dawn's manual fix
on 2026-05-20 cannot recur — the launchd plist will always point at a
file that exists on disk.

## Trade-offs

- We keep an unused `instar-boot.js` file on disk if it was there
  before. That's intentional — deleting it (the old behavior) is what
  caused the bug. Leaving it around costs ~10 KB of disk per agent.
- Migration regenerates the plist via `launchctl bootstrap`. If that
  call fails (e.g., in a CI sandbox without a valid launchd domain),
  the migrator surfaces the error rather than silently leaving the
  old plist. This is correct: any agent running in a real launchd
  context will have it succeed.
