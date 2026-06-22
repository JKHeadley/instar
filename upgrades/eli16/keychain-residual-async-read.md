# The rest of the keychain freezes are gone

You know how your dashboard kept showing "Disconnected" and the agent sometimes thought it had gone to
sleep when it hadn't? We already fixed the two biggest causes: the slow tmux calls, and then the worst
of the keychain reads.

A "keychain read" is the agent asking the Mac's secure password store (the same vault Safari uses to
remember your logins) for the saved login it needs to talk to its account. On a Mac, that question goes
to a single system service shared by every app and every agent on the machine. When that service is busy
— and it gets busy when several agents ask at once — each question can take seconds to answer. The
problem was that the agent asked the question the BLOCKING way: it stood frozen at the counter waiting
for the answer instead of going off and doing other work. While frozen, it couldn't talk to your
dashboard, so the dashboard dropped the connection and the agent's "am I awake?" check misread the
stillness as the computer going to sleep.

The first fix only converted ONE place that asked the blocking question. After it shipped, we ran a live
profiler on the running server and caught THREE MORE places still asking the blocking way — all of them
on the part of the agent that checks, roughly every 60 seconds (and as often as every 10 seconds when an
account is running low), how much quota each of your accounts has left. Each check was reading the
keychain the frozen-at-the-counter way, once per account.

This update converts all three of those to ask the question the non-blocking way: the agent leaves a note
("tell me when you have the answer") and keeps doing its other work in the meantime, so the dashboard
stays connected and the false "I went to sleep" reports stop. Same answers, same timeouts, same safety
behavior if the keychain can't be read — just no more freezing.

One honest note: there is still a SEPARATE freeze being fixed that has nothing to do with the keychain —
it's caused by reading one large JSON file the blocking way. That one is being handled on its own and is
not part of this change. With this update, the keychain class of freezes is finished.
