# Pasting long text into a session from the new dashboard — the plain-English overview

## What this is

Sometimes you want to hand the agent a big block of text, such as a long log, an error dump or a document draft. Typing it into a conversation can cut it off or flood the screen. The agent has a "paste" system for this: the text is saved as a file on the machine, and the session is told where it is, so nothing gets cut off. The old dashboard had a tab for it. The new dashboard did not, so it sent you back to the old one.

## What changes

The Sessions page now has a "Paste to a session" button under the list. It opens a panel where you pick which conversation gets the text (the one you used most recently is already picked and named), paste the text, and optionally say what it is. You see how long it is as you paste. After you tap Send, the panel tells you plainly whether it was delivered, is waiting for a conversation to start, or failed, and a failed send keeps your text in the box. Inside an open conversation, its "⋯" menu has "Paste long text", already pointed at that conversation. A "Recent pastes" list shows what you sent in the last week on this machine, and lets you delete one after asking once.

## What already existed, and what stays the same

The paste system itself is unchanged: same storage, same size and rate limits, same seven-day keep time. This only adds the new dashboard screens for it.

## Safeguards

Pasted text is saved on the machine where the conversation runs, so this panel only sends to conversations on this machine. For a conversation on another machine it does not pretend: it offers to open that conversation, where you can paste into its own message box, which already tells you whether that machine received it. The panel reminds you not to paste passwords or keys.

## What you need to decide

Nothing. This is a small screen addition that a revert fully undoes.

## Every warning has a way to act

When a paste is refused (pasting switched off, too many pastes in a minute, the server not answering, or any other refusal), the message under the Send button now ends with "Ask the agent about this". That link opens Sessions with the question already written, and the pasted text stays in the box to send again. A paste waiting for a session points to Recent pastes, where it can be deleted. A mistake in the input, such as an empty box, gets no link, because the fix is the box right above the message.
