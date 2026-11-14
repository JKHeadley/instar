# The agent stops poking topics Telegram keeps refusing

To learn a topic's name, the agent sometimes sends a tiny test message into the topic and deletes it straight away, because Telegram's reply to that test includes the topic's name. It does this every time its server starts, for each conversation whose name it does not know yet.

For a few topics that test can never work: the "General" topic (which has no name record to reply to) and topics that were deleted long ago but are still on the agent's list. Telegram refuses the test every time. Because the server restarts several times a day, that added up to about 190 refused messages a week. Each one is recorded as a failed message, which makes the message records look much worse than they are.

Now the agent never tests the General topic, and when Telegram refuses the test for a topic, the agent writes that down and leaves the topic alone for a week. If the test failed only because the network blipped, nothing is written down and it simply tries again next time.
