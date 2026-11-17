# Project apps, part 2: custom apps — Plain-English Overview

> The one-line version: the agent can build a small app for one project, and that app runs in a locked box where it cannot touch anything of the owner's, and only the owner's phone decides which version of it runs.

## The problem in one breath

Part 1 lets a project show one of Instar's own pages (the maturation board). But most projects need their own picture: a sales pipeline, a course tracker, a renovation checklist. The agent can write that page. The danger is that the agent can be tricked (a "hijacked agent"), and then the code it writes could be hostile: it could try to steal the dashboard's sign-in, approve things, or show a fake PIN box.

## What this adds

- **A custom app** is one web page the agent writes for one project, stored with its versions and copied to every machine.
- **It runs in a locked box.** The browser treats the page as coming from nowhere, so it cannot read the dashboard's sign-in, its storage or anything on the dashboard page, even if someone opens it on its own.
- **A narrow key.** The box gets a short-lived key that can only read and write that one app's own data and its summary. The key cannot approve anything, change who has access, check a PIN, send messages or read conversations. Tests try each of these and must be refused.
- **Instar's own frame around it.** The top bar always says "made by your agent for <project>", with buttons to go back. The app cannot cover it, open popups or send the window to another site.
- **Only the owner's phone decides which code runs.** When the agent writes a new version, the old one keeps running until the owner approves the new one on their phone with Face ID. The agent cannot fake that approval, even though it knows the dashboard PIN.
- **The design process stays.** Every custom app needs a reviewed design document first, as Justin asked.

## The safeguards against a hijacked agent

- It can't reach the owner's sign-in or powers (locked box + narrow key).
- It can't swap in new code after approval (phone approval per version).
- It can't trick the owner into a fake page opened on its own (the app only loads inside Instar's frame, with a one-time ticket).
- It can't fish for the PIN: a save that contains the PIN is refused and the owner is told.
- It can't flood storage or the conversation (a daily size budget per app; at most one "new version waiting" message a day).

## What is honestly left

A hostile app can still pass small amounts of its own project data out through tricks browsers do not fully block. That data is already the agent's, and the box never holds an owner secret.

## What gets built

The storage and the locked box, the narrow key and its tests, the phone approval of versions, then an example: a sales-pipeline app on a demo project, made through this whole flow, which Justin attaches.

**What the first build leaves for stage 2.** Some machine-to-machine pieces come in a second build: sending an app's writes to the coordinating machine, fetching keys from it, and confirming erasures on every machine. That work is tracked as CMT-1882. Until it lands, only the coordinating machine opens custom apps; another machine shows "still copying" and exposes nothing. An app that sends requests too fast is slowed down, with a plain "asking too often" answer.
