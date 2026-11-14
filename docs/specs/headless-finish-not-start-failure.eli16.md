# Short jobs were being counted as crashes (plain-English overview)

Instar runs many small scheduled jobs, like a health check every few minutes. On a fresh Linux cloud server, each of those jobs did its work and finished in about twenty to thirty seconds. Instar then wrote in its log that the job had "died during startup".

That label was not harmless. Instar keeps count of sessions that die while starting, because that usually means something is broken on the machine, such as an expired sign-in. After three in a row it stops sending work to that machine and tells the owner the machine cannot start sessions. So on a server whose jobs were all fine, Instar decided the server was broken, after about fifteen minutes.

The reason: Instar treats any session that ends within its first two minutes as a failed start. For a conversation that's a fair guess. But these quick jobs are a different kind of session: one question, one answer, then the process exits on purpose. Ending quickly is how they succeed.

Instar already has the evidence to tell the two apart. When a session's process fails, Instar keeps its terminal window around so it can read the failure code. When the process ends cleanly, the window simply disappears. So for these one-shot jobs, a window that disappeared means the job finished cleanly, and Instar now records it as completed.

Nothing changes for conversations or other interactive sessions. Those can quit cleanly at a prompt they could not get past, and still count as failed starts. A one-shot job that fails, for example because it is not signed in, still counts too.

The only decision here is whether "the window disappeared cleanly" is good enough evidence that a one-shot job finished. That is how the operating system reports a clean exit, so yes.
