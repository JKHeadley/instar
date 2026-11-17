# The app on a weak connection, in plain words

**What was wrong.** On a phone with one bar of signal, Justin opened "Needs you" and got a grey loading bar with nothing in it and no message. That screen is a dashboard page shown inside the app. Every dashboard read waited at least 20 seconds and then tried once more, so a bad connection meant about 40 seconds of grey bar, and nothing the page had seen before was shown. The phone apps had the same shape on their own screens: long waits, nothing kept between launches for Needs you or the Work board, and a message typed with no signal was lost if the app closed.

**What changes.** One rule, the same on iPhone, Android and the dashboard: show what you had, say how old it is, and keep trying quietly.

- Status screens keep their last good answer on the device. When the agent cannot be reached they show it straight away with one line: "Offline. Showing what I had at 1:52 pm." The line goes away by itself once the agent answers again.
- A page never sits on a bare placeholder: after a few seconds it says what is happening.
- A page that is just slow on a good connection is not mistaken for a bad connection: a tiny check of the agent decides which it is.
- In the apps, a message you send is kept on the phone until the agent has it. With no signal it says "Waiting for a connection" and goes by itself when the signal is back, using the same id so the agent never gets it twice. After 6 hours it waits for a tap instead.
- An Approve tapped with no signal is never sent later on its own. When the signal is back the app checks the item is still waiting and unchanged, then asks you once more.

**Safeguards.** Nothing private is kept in the browser: no conversation text, topic names, secrets, or anything read with the PIN. Saved copies belong to one sign-in and are wiped on sign-out. In the apps, kept copies live in the app's protected storage and are deleted with the agent.

**What a reader needs to decide.** Nothing new to approve: it is all automatic, and a revert removes it. The open question is only whether 7 days is the right time to keep a saved page (it can be shortened later).
