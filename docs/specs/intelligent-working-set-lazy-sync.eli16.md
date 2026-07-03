# Intelligent Working-Set Lazy-Sync — ELI16 Overview

## What's the problem?

Say you're working on a document on your Laptop. You create a spec file, add a test, commit it. Now you want to switch to working on Mini for a bit. But that spec file you just made? It's still on the Laptop. Mini has no idea it exists.

So you either:
1. Have to manually copy it over (annoying)
2. Go back to Laptop to access it (defeats the purpose of switching machines)
3. Recreate it on Mini (defeats the purpose of saving it on Laptop)

This is broken. When you move your work to a different machine, your **files should come with you**.

## What does this fix?

This spec makes files follow the conversation automatically. When you're working on a topic on Laptop and you move that conversation to Mini, the files you created **automatically sync to Mini**. No manual copy. No asking for it. Just there.

The agent remembers what files you touched on Laptop, and when you switch machines, it fetches those files to the new machine before you need them.

## How does it work?

Every time you create or edit a file in a conversation, the agent writes it down: "The user edited spec.md in this conversation on Laptop at 3:15 PM." It's like a filing system.

When the conversation moves to Mini, the agent looks at that list and goes: "The user has spec.md from Laptop. Let me fetch it." It pulls the file over in chunks (so it works even if the file is big), verifies it's not corrupt, and puts it in the same place on Mini.

If you edited the file on BOTH machines while you were offline, the agent detects the conflict and keeps both versions (you decide which one to use later).

## What does the user experience?

**Before:** Files stay on the machine where you created them. Moving to a different machine means losing access to your work.

**After:** Your files follow you. Create on Laptop, move to Mini, the file is already there waiting.

Example:
- You write a spec on Laptop.
- You move the conversation to Mini for some reason.
- The spec is **already on Mini**, in the exact same place it was on Laptop.
- You continue editing without interruption.

It's seamless because it's automatic.

## Why does this matter?

Goal B is "the agent spans multiple machines seamlessly." But seamless means your work goes with you, not that you have to manually manage files across machines.

This is the difference between "I run on multiple machines" and "you can work on multiple machines without thinking about it."
