# The bounded-input review is done, so its deadline is retired (ELI16)

Our standards say a check that feeds a model must not quietly cut off the text the model is judging. In August there were 45 places in the code that might be doing that, and a lint was set to start failing every build on 23 November unless the list was cleared. Four pull requests merged today went through the last 43 places one by one (two had already disappeared when their features were removed). Each one was either fixed, so the cut is announced or refused, or marked safe with a written reason. The list is now empty.

This change updates the standards document to say the job is done, with links to the evidence, instead of still saying it is unfinished with a deadline. Without it, the deadline lint would fail every build from 23 November even though the work is finished. The honest limits stay written down, including one known blind spot in the detector that has its own tracked report.
