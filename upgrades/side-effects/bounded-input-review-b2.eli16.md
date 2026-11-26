# The agent's checks now see the part that matters, batch 2 (ELI16)

## The problem

Many small decisions inside the agent are made by a model reading some text: "is this resumed session the same conversation?", "does this draft contradict what I believe now?", "what should the summary of this chat say?". To keep things fast, the code often cut that text to a fixed length first, and nothing said it had been cut. The reader then treated a fragment as the whole thing. Our standards say every such cut must be justified or must announce itself, and a lint will start failing every build on 23 November until all 43 places are checked. This is the second batch of ten.

## What we found and changed

The biggest one: when the agent starts a fresh session for a conversation, it hands the session the recent messages so it can pick up where things were. Each message was cut at 2,000 characters, but a Telegram message can be up to 4,096. So a long instruction from the person could arrive cut in half, with no sign. The session would continue confidently from half an instruction. Now every Telegram message arrives whole, and anything longer says it was cut. The same cut existed in a second file that the lint could not see, and it is fixed too.

A smaller one: a ranking step looked at file paths but kept the start of long paths and threw away the end, which is the file name. Now it keeps the file name.

Four other places keep the same amount of text but now add a clear note when they cut, so the model knows its view is partial. In two prompts, one line at the top now explains that every entry is shortened, instead of a note on each line. Two places were not cuts at all (they split a "name:number" label), and one shortened the model's own answer for storage. Each of those now carries a one-line reason.

## Safeguards

No check got new power. Each one just sees more complete or more honest input. Reverting the change undoes it completely.
