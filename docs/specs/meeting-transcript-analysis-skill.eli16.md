# Meeting-transcript analysis for every agent (ELI16)

When an agent sits in on a client call, the operator wants a "post-meeting read" afterwards: what was decided, who does what next, and what the client still owes us. Reading a long transcript once misses things, and the misses are the costly ones: a direct request to the agent buried in small talk, a "this" that decides which item matters, a "maybe" that got written down as a "yes".

Luna, the SageMind agent, built a careful method for this and measured it. On her first full run, seven fresh checkers went over a read that already looked complete and found 35 more things that mattered. Her method makes misses fail a check instead of relying on care:

- every line of the transcript has to be filed somewhere, with its exact words;
- five searches for tell-tale words (the agent's name, "I'll", "important", names and numbers) have to be settled one by one;
- two helpers read the transcript blind, in different ways, and anything they found that the main read did not has to be explained;
- every item has to end up somewhere: an action, a question for the client, a file, or "just information, because...";
- every screenshot or highlight the recorder kept has to be opened and tied to what was said at that moment;
- then fresh checkers keep looking for what is still missing until one finds nothing that matters. If they never get there, the report says "incomplete", never "done".

Justin asked (through Luna) for this to be part of Instar for every agent. This plan ships it as a built-in skill plus its small checking scripts. Everything that touches a real client (where the recording comes from, what gets prepared for the client's page, how the operator is told) stays in each agent's own small add-on scripts, because that differs per client. Nothing is ever sent to a client; changes are only prepared, and publishing waits for the operator.

The review of this plan changed a few things. The checkers are no longer told "this read is incomplete" (that told them what to find); they are asked what is missing and may say "nothing". Only findings that change an action, an owner, a decision or a priority keep the checking going; notes about how firm a yes was are fixed and shown but don't. If a checker contradicts an earlier one, the agent settles it from the exact words, and if the words don't settle it, the operator gets one question while anything that depends on it is held. The helper readers run with no tools at all, so a sentence planted in a transcript can't make them do anything. Client recordings and screenshots stay in that client's own folder and are only shared where the operator chose. And a final check refuses to call a run finished if its records don't add up.

A check of this plan against Instar's rule book (Nov 19-20) found more to fix, and this version fixes it:

- It works on every kind of agent Instar runs (Claude, Codex, Gemini and Instar's own), not only Claude and Codex.
- Private call recordings belong to the person who owns that client. They stay private to that person unless that person shares them through Instar's signed team record, and they are never put somewhere other team members can read just because they can open the same repository.
- When two summaries of a call disagree, the agent goes back to the transcript and lists the disagreement; a summary alone can never be the source of a to-do. Every item quotes the transcript.
- If the agent can settle a question from the project's own records, it does, instead of asking the operator.
- Nothing is prepared for the client on evidence nobody has checked yet, such as a screenshot no reader has looked at.
- The agent checks that it didn't copy client text into its memory or another client's folder, instead of just being told not to.
- What the agent promised in a call, and the transcript and read behind it, reach all its machines even if the place the files live is unreachable, without anyone new being able to see them.
- A run that stops while checkers are still finding things is called incomplete, never done.
- Fixed numbers (exactly two readers, at least two rounds, a set number of retries) became judgment based on evidence, so a short clear call doesn't pay for work it doesn't need, and a messy one keeps getting checked.

It first runs, start to finish, on a throwaway test agent that Echo watches. Only after that passes does it go to development agents and to Luna, who will use it on her next real client call. Only after a real call where the operator finds nothing missing does it go to every agent. Nothing runs on its own; an agent uses it only for a meeting read. Turning it off is one setting.

A further check on Nov 27 led to five more fixes: every one of the agent's machines must confirm it holds the meeting before the read counts as ready, not just one; the whole skill runs on a supervised throwaway agent before Luna; retries and the number of blind readers are judged from what the agent observes, not fixed counts; and a summary bullet holding two requests must have both linked, which every checker now looks for.

**Status.** Draft for Justin's approval. Nothing is built before he says yes.
