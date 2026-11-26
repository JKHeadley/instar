# ELI16: the secret reader finds a key that lives in the plain settings file

## What went wrong

Each agent keeps its secrets (the key its own sessions use to talk to its server, a GitHub key, and so on) in one of two places. Newer setups move them into an encrypted store on the machine, and the plain settings file keeps only a marker that says "this one is in the encrypted store". Older setups, or a machine where that move never happened, still keep the value in the plain settings file.

Agents read secrets with one small helper script. That script only ever looked in the encrypted store. On the M5, the server key was still in the plain settings file, so the script said "no such key" on its error channel and printed nothing. Most callers hide that error channel, so they quietly got an empty key, and every request they made was refused as unauthorised. The throughput session hit this on the night of Nov 17 and had to find the key another way. The instructions agents follow do list a second line that reads the settings file, but anything that used only the first line failed silently.

## What this change does

When the encrypted store doesn't have the key, or the machine has no encrypted store at all, the script now looks at the same name in the plain settings file. If there's a real value there, it returns it, and adds one line on the error channel saying where it came from (never the value). The marker that only says "this is in the encrypted store" is never returned as if it were the key.

If both places have the key, the encrypted store wins, so nothing changes on machines that were already moved over.

## What it does not do

It doesn't move any secret, change any file, or make the plain settings file more or less readable than it already is. The script only reads what the agent's own server already reads from the same file. Every other rule stays: the value goes only to the output it's piped into, and on any failure nothing is printed there.

## How it reaches existing agents

Every update already rewrites this script for every agent, so existing agents get it with their next update. Nothing else is needed.

## Rolling it back

Undo the change. No saved state or settings depend on it.

## What you need to decide

Nothing.
