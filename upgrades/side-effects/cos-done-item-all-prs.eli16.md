# Chief of Staff: a finish line that names several pieces of code needs all of them merged

The Chief of Staff tracks projects against finish lines the owner agreed to. Since PR 3234 it can check a finish line itself when the line says which piece of code must be merged, written as "PR JKHeadley/instar#3092 merged". Many finish lines are delivered by several pieces of code, so one line can name several of them.

The problem: the checker only looked at the first one it found. A line naming six pieces of code would be marked done as soon as the first one merged, even if the other five were still open. That would tell the owner a project was finished when it was not, which is the worst kind of mistake for a tracker whose whole job is to be trusted.

What changes: the checker now looks at every piece of code the line names. If any one of them is not merged, the line is not done. If none failed but one could not be read (GitHub unreachable, or a repository the owner never linked to the project), the answer is "not known yet" rather than a guess. Only when every one of them merged does the line count as done.

What stays the same: lines naming one piece of code behave exactly as before, plain-words lines still wait for the owner, and the checker still never reads a repository the owner did not link. Nothing new is asked of the owner. If this turned out wrong, undoing the one change restores the old behaviour.
