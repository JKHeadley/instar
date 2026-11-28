# Show the dashboard command in the command reference

## Why the documentation check failed

The agent's dashboard lets you manage the agent from a browser. On the computer running the agent, the command `instar dashboard open` opens a one-time link to that dashboard. The documentation check used the source file name to guess how the command was spelled. For this command, its guesses joined the last two words together. The check therefore missed the spelling that people actually type.

## What changes

The command reference now shows a working example. Run `instar dashboard open`, then enter your dashboard PIN in the browser. If you have more than one agent on that computer, use `--dir <dir>` to choose the agent's folder. The documentation check now connects the exact command shown in the reference to the source file that implements it.

## How it was checked

A focused test gives the checker a fictional repository with a document that uses the real command spelling. The check finds the document and counts it toward coverage. The full documentation coverage report also reaches its existing command coverage threshold with this change.
