# Sending from the app into a Telegram topic the agent can see

Justin opened the "Email Check - Justin" conversation in the app. It is a Telegram topic where Luna posts notices about her email check job. He could see the conversation and every notice in it. He sent a photo and a message, and the app answered "This conversation no longer exists on the agent." The message never arrived.

**Why.** Luna runs on two machines, the laptop and the Mac Studio. The app lists Telegram topics from both. The laptop had named this topic when the email job used to run there. The Studio now serves the app. It holds the topic's history, because it posts the job notices into it, and the app's history read shows whatever history the machine holds. But before taking a message or file, the Studio checked a different, narrower list: topics it had named itself or tied to a session. This topic was on neither, so the Studio called it missing while showing its messages.

**The fix.** There is now one rule for "does this machine know this topic", used by every way the app writes into a Telegram topic: sending text, uploading a file, pinning, marking read and opening the session. A topic is known when this machine named it, tied a session to it, or holds history for it. The last part is what the history read already used, so what the app can show and what it can send into now agree. A topic this machine has never seen at all is still refused, and the per-person access checks around each route are unchanged.

**The job notice.** The same screen showed "this machine holds the scheduler but the job is pinned elsewhere", which repeated daily for days. It never said where. The job was pinned to the laptop, which runs no scheduled jobs while the Studio holds the scheduler. Luna has already replaced it with a job on the Studio that makes Tasks cards for emails that need Justin. The notice now names both machines and says what to change.

**What this gives up.** A topic that was deleted in Telegram but still has history in the log is now accepted. A message sent there fails at Telegram, as it would for any send, instead of being refused up front. Checking history on a first miss reads the message log once for that topic and then caches it. The history read already does this for any topic number, so this adds no new cost.

**Your decision.** Nothing is needed. Reverting this change restores the old rule.
