# A test that checked the wording of an error — Plain-English Overview

> The one-line version: one automated test compared an error message word for word, the newest version of Node words that message differently, and so the test failed on any machine running it; the test now accepts both wordings and checks the thing it was really there to check.

## The problem in one breath

The agent keeps its secrets in an encrypted file. One test damages that file on purpose and checks that reading it fails in the right way: as "this data is corrupt", and not as "you are using the wrong key", which is a different problem with a different remedy.

To tell which failure it got, the test compared the text of the error message with the text it expected. That text does not come from this project. It comes from Node, the program everything runs on, and from the encryption library inside it. Node 24 says "Unsupported state or unable to authenticate data". Node 26 says "bad decrypt". Same failure, different words.

On machines with Node 24 (the Studio and the M5) the test passes. On Justin's laptop, which has Node 26, it fails every time. That matters now because the laptop is the one spare machine strong enough to become a third line for running tests, and a machine that fails one test on every change cannot be used for that.

## What already exists

- **The secret store**, which simply passes the encryption library's error along when a file is corrupt.
- **A neighbouring test** that pins the other case, the wrong key, by its own message ("encrypted with key id …").

## What this changes

Only the test. It now accepts either wording for a corrupt file, and adds a second check that says what the first was really for: the error must not be the wrong-key message.

## The safeguards

**The test still tells the two failures apart.** If corruption ever started being reported as a wrong key, the new second check fails, on any version of Node.

**Nothing in the product moved.** The secret store does not look at this text, so there is no behaviour to change.

## What is not proven

The new wording was taken from the laptop's own failure output, which was cut off after "bad". I have not yet run the changed test on Node 26. If the full message is something other than "bad decrypt", the test will fail there again and show the exact text, and the fix is one more word.

## What you need to decide

Nothing.
