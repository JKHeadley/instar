# ELI16 — Show which account the agent is actually running on

## The plain-English version

You have five Claude accounts in your pool now. The dashboard shows all of them with green bars and the word "Active." But "Active" there just means "this account is healthy and could be used" — it does NOT mean "the agent is using this one right now." So when you looked at the dashboard, you couldn't tell which account the agent was actually burning at that moment. That's the gap this fixes.

## Why it wasn't obvious

Here's the subtle part. The pool today is more of a *monitor and a safety net* than a *chooser*. Your normal agent sessions don't go "ask the pool which account to use" — they just run on whatever your computer's default Claude login is. The pool only steps in to *swap* accounts when one hits its limit. So nothing anywhere wrote down "this session is using that account," which is why the dashboard couldn't show it. Every account just said "last used: never."

On top of that, the default Claude login is a bit messy — there are two config files and they can disagree about which account is signed in. So you can't just read a file and trust it.

## What this change does

It adds a small, honest answer to one question: **which account is the agent running on right now?** Instead of guessing from a config file, it asks Claude's own "who am I logged in as" command (`claude auth status`) — the authoritative source — gets back the real email, and matches it to one of your pool accounts. The dashboard then puts an "● In use now" badge on that account's card and highlights it, so at a glance you see exactly which one is live.

It's completely read-only. It doesn't change which account anything runs on, doesn't swap anything, doesn't touch how sessions launch. It just *reports*. If the lookup fails for any reason, it quietly shows no badge rather than breaking the page. The lookup is cached for a minute so the dashboard refreshing every few seconds doesn't keep re-running the command.

## What's deliberately NOT in here

You also asked for the deeper fix: *pin* the agent to a specific chosen account so the default is never ambiguous and "which account am I on" is always deterministic. That part changes how every session is launched — it's the critical path — so I'm doing it as a separate, carefully-reviewed change rather than rushing it in with this display. This PR gives you the visibility immediately; the pinning follows.

## What you'll see

On the Subscriptions tab, the account the agent is currently using gets a green "In use now" badge and a green outline. Right now that's your gmail account (Justin). The other four still show their quota and "Active" (healthy), just without the in-use badge.
