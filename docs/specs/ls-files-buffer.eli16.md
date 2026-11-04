# Why a test needed a bigger buffer, in plain English

One of Instar's tests asks git for the list of every file in the repository. Node, which runs the test, only accepts 1 MB of answer by default. The repository has grown, and today that list went just past 1 MB, so the test crashed. It failed on the main branch and on every pull request, including ones that had nothing to do with it, which stops everything merging.

The fix lets that one test read up to 64 MB. It doesn't change what the test checks, and it doesn't touch anything an agent runs.

Why the list is so large: every change adds a few small record files that stay in the repository. That keeps growing, and this fix doesn't change that, but 64 MB is a long way off. I also looked at other places that read similar lists, and the ones I found already allow much more.

A reader doesn't need to decide anything here.
