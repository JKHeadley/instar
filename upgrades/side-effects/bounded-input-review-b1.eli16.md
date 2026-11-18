# Making sure the agent's checks see the part that matters (ELI16)

## The problem

Inside the agent, many small decisions are made by a model or a pattern-matcher reading some text: "was this error a rate limit?", "did the person already give permission?", "did the agent just promise something?". To keep things fast, the code often cuts that text to a fixed length first. The trouble is that a cut is invisible. The reader sees a piece, assumes it is the whole thing, and answers confidently from it. Our standards say every such cut must either be justified or must say out loud that it is a cut. There were 43 places left to check, and a lint will start failing every build on 23 November if they are not done.

## What this batch did

This is the first of four batches: 10 places in the core of the agent. Each was read by hand to see who actually uses the text and whether the cut could change their answer.

Three were real bugs. When a Gemini call failed, the code looked for "rate limit" wording only in the first 600 characters of the error, so if the tool printed warnings first, a call that should have waited and retried just failed. Now it looks at the whole error. When the agent asks permission, a check looks at whether the person already granted it, but it only saw the first 280 characters of the person's message, which could leave out the actual "you have my approval" words. Now it sees the whole message (anything up to Telegram's limit). And the promise tracker read only the beginning of very long replies, while promises like "I'll follow up in an hour" are usually at the end. Now it reads the start and the end.

Two more places now keep the same amount but add a clear note saying the text was cut. Five places were checked and are fine as they are (for example, a preview a person reads, or a saved record with a size limit), and each now carries a one-line reason.

## Safeguards

No check got new power to block anything. Two small helper files are now also listed, with reasons, in the record of which code the message-delivery safety test covers; neither of them delivers messages. Each one just sees more complete evidence. Everything is undone by reverting the change.
