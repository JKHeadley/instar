# Phase 0 results for the context-budget work — Plain-English Overview

## What this is

The context-budget plan, which aims to make long conversations cheaper without losing the thread, opens with a "Phase 0": a list of things to check on real machines before anything depends on them. This change writes down what those checks found, with the numbers and where each came from, and adds small scripts so anyone can take the same measurements again on another machine. It changes nothing that runs. It is a report plus measuring tools.

## What was found

**The fix for "context never comes back after a squeeze" does run now.** When a conversation gets too long, Claude squeezes it down (a "compaction"). Instar is meant to hand back a recovery note afterwards, and for months it never did. Since yesterday's fix, all 3 squeezes on this machine got the note. Before the fix, 47 out of 47 got nothing.

**But the note arrives mostly as a pointer, not as the note itself.** Claude Code only passes along the first 10,000 characters of anything a startup hook prints. Past that, it saves the text to a file and shows the model a 2,000-character preview and the file's location. Our recovery note is about 45,000 characters, so the model sees its first lines and a pointer to the rest. Tests at three sizes confirmed this: about 9,500 characters arrived whole, and 150,000 characters arrived as the preview only. That also means the plan's idea of handing a fresh session a 50,000 to 150,000-token briefing through this route will not work as written.

**What a long conversation costs per step today.** On this machine, a step in a long conversation costs about 54,000 "input-equivalent" tokens. Most of that is re-reading the cached conversation. This is the baseline the project has to cut in half.

**Other findings.** The topic-memory layer collects notes but surfaces none of them yet: every note is still at the lowest confidence level. The person typing makes up almost none of what fills a conversation; tool output and automatically added text make up most of it. The built-in token counter misses most sessions on this machine, because they run under other login folders.

## What is not done

Everything here comes from one machine, the Mama PC. The Mac Studio, which does most of the heavy work, still needs the same scripts run on it. Checks that need the "fold" machinery (cost per fold, rollback, timing) cannot be run until that machinery exists. They are marked as deferred, not skipped.

## What you need to decide

Nothing for this change. The 10,000-character limit is a design question for the slices that deliver recovery notes and briefings, and the report flags it for them.
