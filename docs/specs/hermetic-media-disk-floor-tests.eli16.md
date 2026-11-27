# Media tests that do not depend on the test machine's disk, in plain words

When a phone sends the agent a photo or a voice note, the agent first checks that its disk still has at least 5 percent free, so it never fills the disk. Our automatic tests start small test agents that share the real computer's disk. On a test computer that happens to be almost full, the test agents refused every photo and voice note, and four test files failed even though nothing in the code was wrong. That is what blocked the Telegram fix tonight.

The tests now tell each test agent's media store that the disk has plenty of room, so the result no longer depends on which computer runs them. The real 5 percent rule is unchanged, and one test still pretends the disk is full to prove the agent refuses the upload and says so plainly.
