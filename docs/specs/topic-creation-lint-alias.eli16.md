# The guard on notification floods could be walked past by renaming one thing

> The one-line version: the check that stops anything but the funnel from creating Telegram topics was looking for a particular *word*, so ten different ways of spelling the same call went straight past it — and now the word it looks for is the one that can't be changed.

## The problem in one breath

Instar can create Telegram topics — the little threaded sub-conversations in a group. Three separate times, a feature created them in a loop and buried the operator under a wall of new topics.

The fix was a ceiling: exactly one function in the whole codebase is allowed to create a topic, and that function counts how many it has made recently and refuses past a budget. A check then proves nobody reaches around it to the raw Telegram API.

The check worked by looking for the *phrase* that reaches the raw API. Which means it was really asking "did you write it the way I expect?" — and the answer is easy to make no.

## What was actually broken

Eleven disguises were written and run against the real check before anything was changed. **Ten of them walked straight past it.** Not exotic ones. Things like:

- Put the API call in a variable first, then call the variable.
- Call the same thing through a slightly different spelling of the same access.
- Split the method's name in half: `'createForum' + 'Topic'`.
- Put the name in a constant at the top of the file and pass the constant.
- Put the argument on its own line — the check read one line at a time, so a line break split the phrase in two.
- Import the API call under a different name.

The eleventh disguise was already caught, and this change claims no credit for it. It is kept as a test so it stays caught.

## What this changes

The check stopped asking *which spelling* was used, and started asking a question that has no spellings: **does this file name the raw Telegram method at all?**

That works because the method's name has to appear somewhere for the message to reach Telegram — whatever you call the thing you send it through. So the disguises above all collapse to the same question. Splitting the name in half, hiding it in a constant, or building it out of a template are all followed back to the same value.

This is done by reading the actual parsed structure of the file rather than searching its text, which is what makes "follow it back to where it came from" possible at all.

## The safeguards, which matter more here than usual

This check **blocks commits**. A check that misses something costs you a bug later. A check that wrongly flags correct code costs everyone, immediately and constantly. So the tests push hard in the other direction: thirteen of them exist to prove correct code is still allowed.

Calling the funnel is fine. Listing the method's name as a key in a lookup table is fine — there is a real table in the codebase doing exactly that. Mentioning it in a comment is fine, and in fact the old check got that *wrong* and failed the build on a comment; that is fixed here too. Naming a different Telegram method is fine. Mentioning the method inside a sentence in an error message is fine.

**And one piece of correct code did get caught, which is worth saying plainly rather than quietly fixing:** another lint keeps a list of words it watches for, and `createForumTopic` is on that list. It is a list of words, not a call — that file cannot reach Telegram at all. It has been added to the exceptions list with that reason written next to it. So this change made the exceptions list one entry longer, and that entry is the honest price of asking a broader question.

## One result that corrected me

To check the fix was doing what I claimed, I built a crippled copy with the "follow the name back to where it came from" machinery removed, and ran all ten disguises through it. **Eight of the ten were still caught.**

So the machinery is not the fix. Changing the *question* is. The follow-it-back part earns its place on exactly two disguises — splitting the name across a `+`, and a web address whose front half sits in a variable — plus pointing at the right line for the rest. Writing it up the other way round would have sounded better and been false.

## What is still open

Written down here rather than left to be discovered later:

- If the name is **built while the program is running** — assembled from pieces at runtime, or read from a settings file — nothing static can see it. That is the floor of this kind of check.
- If the name lives in **another file** and is imported, it is not followed.
- If someone writes `client['createForumTopic'](…)`, it is **deliberately not flagged** — because the funnel itself has that same name, so the legitimate way of calling it looks identical. Flagging it would break correct code, and that is the more expensive mistake.
- Shell scripts are checked as plain text, so a name assembled across several shell lines escapes.
