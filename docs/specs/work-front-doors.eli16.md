# Conversations and Work as Instar's front — Plain-English Overview

> The one-line version: every Instar screen opens on the same three doors (Conversations, Work, Agent) with one "Needs you" list on top, and that list is one answer from the agent that every screen shows the same way.

## The problem in one breath

Today the website, the iPhone app and the Android app each have their own idea of the front page. The website's Home gathers about twenty things that might need you; the phone shows a different, shorter list; and the Mac app was about to invent a third. Things that need you can show up on one screen and not another, and the many tabs (Home, Chat, Work, Capacity, More) bury the two things people actually come for: talking to the agent and seeing the work.

## What already exists

- **The website's Home list** — it already reads every place that can need you (accounts, permission requests, plans, the work board, passwords, learned skills and more) and turns each into a row. It only runs inside the browser.
- **The phone's own needs list** — the attention queue and health problems, each with its own buttons (Done, Ignore, Ask).
- **The work board** — cards for decisions the agent needs, each with its own conversation and the existing review screen before anything is approved.
- **Every existing page** — Machines, Accounts, Permission slips and so on, each with its own address.

## What this adds

The biggest change is one server answer, "Needs you", that the website, both phone apps and the Mac app all draw. It is built by running the website's own Home rules on the agent's server, so no screen can disagree with another or with the page a row opens. It says plainly when part of it could not be checked; it never shows an empty list just because something failed.

Around that:

- **Three doors everywhere.** Conversations, Work (opens straight on the board, or Promises and Plans if the board is off), and Agent (everything about how the agent runs: Fleet, then the old Work, Capacity, People and Settings pages as sections, names and icons only).
- **Home stops being a page.** Its old link lands on Conversations with the Needs-you strip open. Every old page address still works.
- **A primary agent.** The phone opens on the agent you pick. This is a setting on your phone, not something the agent stores.
- **The card on its conversation.** When you open a card's conversation on the iPhone, the card sits pinned on top. Its main button opens the existing review; the strip itself never approves anything.
- **A canary.** Once an hour the agent sends a made-up need through the real list and checks it comes back. Two misses in a row raise one notice.
- **Agents know about it.** The agent's instructions now say to read the same list when you ask "what needs me?" in Telegram or Slack, so nobody needs the app to get the answer.

## The safeguards

- **No new permission.** The list only reads. Every action still goes through its own page and its existing check (PIN, Face ID, Secret Drop). The approval rule on the board is untouched here.
- **Each person sees only their own.** The owner sees everything. A member's or guest's phone sees only what that phone could already read (the board, when its own rule lets them), and owner-only parts are left out, not shown as "could not check".
- **Honest gaps.** A source that failed is named ("Could not check the work board"), and the count shows a "+" so you know it may be more.
- **Bounded.** One shared answer every ten seconds, at most six reads at a time, at most a hundred rows sent; one-time passwords and tokens never appear in it.
- **Several machines.** Each source's posture is written down; the ones that are local to one machine by design (health of this machine, money settings, pending passwords) are named with their reason.

## What you need to decide

Nothing new. Justin approved the spec with option C on 2026-11-15; the board's approval rule (option C itself) ships separately with the trust-journey spec. This stage changes what you see, not what anything is allowed to do.
