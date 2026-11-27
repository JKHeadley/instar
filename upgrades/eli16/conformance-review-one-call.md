# ELI16 — The constitution check asks its two questions in one go

## The problem in plain words

Before a spec (a written design) is approved, Instar runs a built-in constitution check on it. The check asks an AI model two questions. First: does this design break any of our standards? Second, when the spec names the principle it says it serves: does the design really, plainly fit that principle?

Until now each question was its own call to the model. Every call re-sends the whole spec, and the model service adds about 15,000 tokens of fixed setup to each call. So the second question paid for the spec and the setup all over again. Over one week on the Studio that second call ran 566 times and used about 12 million tokens.

## The fix

Ask both questions in one call, and read both answers from one reply. The instructions for each question are the same words as before; only the reply format changes to hold both answers.

## What did not change

- A spec that failed the principle-fit question before still fails it. The answer is still recorded as its own field, with the same three possible values: fit, weak, or none.
- If the reply comes back broken or cut off, or the call fails, the principle question is asked again on its own, exactly as it used to be. So a weak or failing fit can never slip through because of the merge.
- A spec that names a principle the constitution does not contain still gets "none" without any model call.
- The spec text stays fenced off as untrusted content, after all the instructions, and it cannot move them.

## What you notice

Nothing, except that the check finishes about 14 seconds sooner and costs about a quarter fewer tokens when a spec names its principle.
