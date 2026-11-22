# Clear questions when changing a conversation's engine

This repairs the question you see when moving a conversation to another engine. It names the conversation and explains what will happen, instead of showing internal terms such as “framework” and “live”. Each question asks you to reply to that message with yes.

Several questions can wait in the same chat. Answering one changes only the conversation named in that question. Progress messages no longer erase the questions. An intentional reminder can arrive without being hidden as a duplicate, and you can still reply to the original question after a reminder.

Only an exact yes tied to a delivered question applies the change. If you write “1) yes”, quote the request and add yes, or include another instruction, nothing is applied automatically. Your message still reaches the agent. It can send a short reminder, such as “To move the dashboard conversation to Codex, reply to this message with yes.” If it cannot tell which conversation you mean, it asks.

No model decides that you gave permission. The server still checks your verified identity, which question you answered, and the exact change it offered. Changed settings, expired questions or a conversation moving to another machine can require a fresh question. It never invents an old approval after a restart.

The broader idea of letting a model interpret permission is parked separately and remains unapproved. This smaller repair goes through ordinary tests and verification before merging. It preserves the current limits on who may change each conversation, while making the questions easier to understand and keeping pending questions from disappearing.

If you answer a question posted by the server, the conversation agent also receives that specific question as context. It can give a useful reminder instead of claiming that no question exists. That context is checked against the current owner, audience and unchanged change; it never turns your wording into permission.

The guiding rule is that the agent proposes and the person approves. The agent prepares the settings and recovers the right question; you only decide whether to accept that specific change. The tests establish that this division still holds in the real channel.

Reminders also come from the server's registered question operation. That matters because replying to the reminder must identify the same change just as safely as replying to the first question. An ordinary chat message cannot create a new approval.
