# Quiet-Settings Follow the Agent — plain-English overview

## The problem in one story

You told me "quiet these alerts." I did — but that decision got written into ONE computer's settings file (the Mini's). Two days later your Laptop, which had been offline, rejoined with its OLD settings and re-flooded your phone with the exact alerts you'd already turned off. Your decision didn't follow *me* — it stayed stuck to one *machine*.

## The fix

Give the agent one small, shared "operator decisions" notebook that every machine keeps a synced copy of. When you say "quiet X," the decision goes in the notebook. Every machine reads the notebook on startup and lays those decisions **over** its own local settings. A machine that was offline when you decided gets the notebook the moment it rejoins — and because it reads the notebook as it boots, it comes back *already quiet*. The rejoining-stale case (the exact incident) is fixed by construction, not by anyone remembering to re-apply anything.

## What's allowed in the notebook (the important safety line)

Only "noise knobs" — settings that change **what you hear** (which alerts buzz, thresholds). The allowed list is written in the code itself, so it can only grow through a reviewed code change, never by anyone (including me) editing a config at runtime. Deliberately banned: anything structural or safety-bearing — the development-agent flag, mesh/topology settings, money settings, secrets, the safety floors, and even "where alerts get sent" (redirecting alerts is a real security lever, so it's excluded until it can be properly validated). Worst case if something goes wrong here: an alert is louder or quieter than intended. Never: the agent gains an ability it shouldn't have.

**Extra lock on the three riskiest switches.** Three of the allowed settings can turn OFF a detector that watches the system itself (like the token-burn alarm). Those get a stronger rule: I can't flip them off on my own at all — the server itself messages you for a yes/no, and only YOUR reply commits the change. Turning a detector back ON needs no such friction. And every "detector off" decision posts one calm, un-deletable notice to your alerts topic — so nothing can ever be quieted invisibly, not even by me.

## How it behaves day to day

- **You decide once, conversationally.** "Quiet the machine-drift alarms everywhere" → I confirm the exact setting, write it to the notebook, and it pushes to all online machines within seconds.
- **Machines already running** can't absorb most of these settings mid-flight (they read settings at startup), so they mark themselves "will apply on next restart" — visible on the dashboard — and quietly restart at a clean moment (never while handling your messages or mid-work). That's the "auto-apply" you approved.
- **Undo is one lever:** delete the notebook entry and every machine returns to its own local file value — including machines that are offline right now (the deletion syncs like everything else, so nothing "resurrects" later).
- **If two machines get contradictory decisions during a network split,** the newest one wins and the overwrite is flagged for you — never silently.
- **A watchdog we already have** (the machine-coherence guard, with the calm-alerting behavior you approved last week) double-checks that every machine's *actual* behavior matches the notebook — so a bug in this new machinery gets caught by an older, independent system.

## What could go wrong, honestly

- If the sync layer is down, machines just keep their current local settings — nothing breaks, and the status page shows sync state.
- A running machine that never finds a clean restart window stays visibly "pending" — it won't force a restart under live work, and the watchdog eventually flags it if it persists.
- If the notebook file is ever corrupt, a machine boots on its own local settings and says so loudly — it never guesses.

## Rollout

Like everything else recently: it ships **dark** (off everywhere), turns on for your machines first in observe-mode, and the final proof before it goes anywhere wider is a literal replay of the original incident — quiet a setting with one machine offline, boot that machine, watch it come up quiet.
