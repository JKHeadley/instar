# Native Proposals and How I'm doing inside: plain overview

## What this is

The Instar iPhone app is replacing web pages with real app screens, one by one. This adds two more. **Proposals** shows the fixes the agent suggests after it sees a failure it hasn't met before. **How I'm doing inside** shows the agent's own view of itself: what it recorded lately, which problems keep coming back, whether the evidence backed up what it claimed, and what reviews of its corrections found.

## What already exists

Both pages exist on the web dashboard, but a phone can't read the data behind them, because the phone signs in with its own key and only a short list of addresses accept that key. The same approach already gave the app its Schedule, Machines, Plans and Insights screens.

## What's new

Two new read-only addresses for the phone. Each builds a short summary from a fixed list of fields. Only the owner's phone, or the agent itself, can read them. Other people's phones are refused. If the agent runs on several machines, the answer includes each machine that replies and names any that didn't.

## The safeguards

Neither screen changes anything. Dismissing a proposal stays in the dashboard, behind its existing check. No record ids, signatures, raw AI output, file paths or keys are sent: file paths in text become "[a file]". What other machines send is treated as untrusted and rebuilt field by field. When something can't be read, the screen says "can't tell". It never shows that as zero or all clear. Reading costs no AI usage.

## What you need to decide

Nothing. The operator asked for every feature to be native, and these are read-only copies of what the owner can already see. If it turns out wrong, undoing the change removes the two addresses and the app goes back to saying "update the agent".
