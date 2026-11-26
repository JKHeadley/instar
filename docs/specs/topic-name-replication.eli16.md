# Telegram topic names reach every machine (ELI16)

## What this is

The agent runs on several computers at once. Only one of them, the "lead", listens to Telegram. When a conversation topic is created or renamed in Telegram, only the lead hears about it, so only the lead knows the topic's name. The other computers keep a list of topic names too, but nobody ever tells them new names.

That was fine until the lead died. When the old Mac Studio went down on 19-20 November, 13 project conversations showed "Name not available" on every remaining computer, and someone had to type the names back in by hand on three machines.

## What already exists

The agent already has a way to copy small records between its computers: each computer writes records into its own journal, and the others read those journals every few minutes. Conversation pins and suggestion decisions already travel this way.

## What is new

- Whenever a computer learns a topic's name from Telegram (it created the topic, renamed it, or saw Telegram's "topic created" or "topic renamed" message), it writes a small record: which topic, the name, and when.
- Every other computer picks up that record, puts the name into its own list, and saves it to disk, so the dashboard and the app on that computer show the right name.
- Every computer that accepts a new name also writes the same record into its own journal once. That way, if the computer that first learned the name dies, the others still have it and can hand it to a rebuilt machine.
- When the change first ships, each computer shares the names it already has, marked "from before". Those only fill in blanks: a "from before" name never replaces a name another computer already has, because we cannot tell how old it is. The lead's "from before" names count for more than the other computers' ones, because only the lead ever saw renames; so a computer that happens to update first cannot spread an old name. This happens once per computer.
- A rename can arrive late (for example after a restart). Each rename carries Telegram's own time and message number, so a late, older rename never replaces a newer one, and a message quoting the topic's original name never undoes a rename.

## Safeguards in plain terms

- An older name never replaces a newer one. Every record carries a time, and the newest one wins; a real rename from Telegram always beats a "from before" name.
- A computer never re-announces a name it just received as if it were new, so records do not bounce around forever.
- It cannot block, move or send anything. The worst it can do is show a wrong name, and the next rename fixes that.
- If anything in this goes wrong at startup, the computer reports it and carries on exactly as it does today.
- There is an off switch (`multiMachine.stateSync.telegramTopicNames.enabled: false`), and names already copied stay correct if it is turned off.

## What the reader needs to decide

Nothing. This is a fix for a gap found in the outage post-mortem the owner approved. It changes no rules, asks no one for anything, and ships on by default wherever the agent already copies records between its computers.
