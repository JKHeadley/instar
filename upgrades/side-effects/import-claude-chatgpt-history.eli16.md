# Bringing your Claude and ChatGPT chats into Instar, first part (ELI16)

## What was wrong

People who switch to Instar leave all their old chats behind in the Claude or ChatGPT app. So they keep going back there to look things up, and the switch never really happens.

## What this adds

Both apps let you download your data as a zip file. Now your agent can read that file and show you a plain summary first, something like "We'll copy 412 chats and 3 projects from Claude. 2 things that looked like passwords were removed." Nothing is saved until you say yes. After that, your old chats sit in a private folder on your computer, with their original dates, and your agent can search them when you ask about something you discussed before.

## How it stays safe

The zip is checked carefully before anything in it is opened. It's refused if it tries tricks like a file name that reaches outside its folder, a link, or a tiny file that unpacks into something huge. Passwords and keys are removed from your chats. The old chats never leave this computer. Your agent sees them only as quoted history from another app: if an old chat says "ignore your rules", that's just a line of history, not an order.

## What comes later

The Mac app's "Imported" section, continuing an old chat, keeping the facts the old app remembered about you (only the ones you tick), and importing Codex and Claude Code sessions.
