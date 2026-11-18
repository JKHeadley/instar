# Secrets you hand to your agent stay on the machine that asked — plain-English overview

## What this is

When you paste a secret into one of your agent's secure pages, the machine that asked for it keeps an encrypted copy until the agent uses it. If you run your agent on several machines, they share some secrets with each other. These pasted secrets were being shared too, and a copy could stay on another machine long after the agent used it.

## What changes

Pasted secrets now stay only on the machine that asked for them; they are no longer copied to your other machines. Using a secret now removes its stored copy first, and if that can't be done the agent is told to try again rather than being told it worked.

## What you would notice

Nothing when you hand over a secret. Secrets handed over before this update may still have a copy on your other machines until they are used or removed there.

## What you need to decide

Nothing. It is a fix, and a revert fully undoes it.
