# The automatic merger only lines up changes that passed their tests

Before a change is merged automatically, it is tested in full on one of the agent's machines, and the result is kept as a record. The automatic merger then looks for changes that "have a record" and merges the oldest one.

The flaw: a change whose tests had failed also "had a record". So the merger would pick a failed change, try to merge it, get refused (the final safety check never lets a failed change through), wait, and try again later. Because it always starts with the oldest change, a failed one at the front of the line held up every working change behind it. That happened today.

Now only a record of a passing test run counts. A change whose tests failed simply waits until someone fixes it and it is tested again, and the changes behind it are merged as soon as they pass. Nothing that could not be merged before can be merged now; the merger just stops wasting its turns on changes that are certain to be refused.
