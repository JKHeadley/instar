# Kept setting promises follow the same rules as changing settings — plain-English overview

## What this is

Your agent can promise to keep a setting at a certain value, and if the setting drifts it puts it back automatically. Changing settings directly through the agent's API has rules: some settings need your PIN, some can't be changed through the API at all (like which program a session runs), and nothing may quietly raise how much the agent is trusted. The automatic "put it back" step didn't follow those rules, so it could change things the direct route refuses.

## What changes

The automatic correction now follows exactly the same rules as the direct route. Anything it isn't allowed to change is still checked and still reported when it drifts; it just isn't changed back automatically.

## What you would notice

Nothing for ordinary settings. A protected setting that drifts is reported to you rather than silently changed back.

## What you need to decide

Nothing. It is a fix, and a revert fully undoes it.
