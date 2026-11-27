# Running the Real-Conversation Benchmark

This tool takes the private set of questions about one real project conversation and runs a fair test. Each question is answered three ways: with no background, with a short summary of the conversation, and with the full conversation. Each way is repeated several times. Two judges from different AI companies then grade every answer against reference notes written beforehand.

The summary is written by a model that sees only the conversation, never the questions or the reference notes. The model that answers never sees the reference notes, and the judges are never told which version an answer came from. All of the private text stays in one folder on the machine that runs the test. The final totals file holds only counts and identifiers.

An answer that declines to decide, because it was given no background, does not reach the reference decision, so it does not get that point. It is not counted as a serious mistake, though. Only an answer that states the wrong decision on a high-stakes question counts as one.

The totals show how often each version got every point right, how often a judge found a serious mistake, how much the repeats varied, and how each version compared with the others on the same question. They are a development result. They do not approve any change to how the agent shortens its context.
