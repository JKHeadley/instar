# A queued reply from a session is still a reply when recovery sends it

> The one-line version: when a reply you wrote could not go out the first time and the server retries it later, it is now sent as your reply instead of being filed away as a quiet notice.

## The problem in one breath

When a session answers someone on Telegram and the send fails with a temporary error, the reply is saved in a queue and the server retries it. The retry path labels the saved reply "imported from the queue" and the last check before sending only recognised replies that came straight from a session. So the retried reply was treated like an automated notice, dropped into the quiet feed that nobody reads in real time, and marked as handled. Twelve real answers to the operator vanished this way over one day.

## What already exists

- **The reply script** that sessions use to answer on Telegram. When a send fails, it writes the reply to a local queue, together with a fingerprint of the session's own credential. It never writes the credential itself.
- **Recovery**, which later reads the queue, matches that fingerprint against the credentials the server issued to sessions that are still running, and labels the saved reply with the session that wrote it. A reply with no fingerprint, an unknown fingerprint, or a session that has since ended gets no session label.
- **Quiet by Default**, the gate that lets real replies through and files automated notices quietly. It also knows which sessions are scheduled jobs, from the server's own records, so a job cannot claim to be a reply.

## What this adds

A saved reply that recovery has matched to a live session is now treated as that session's reply, exactly as if the session had sent it directly. It goes to the topic it was written for and the gate lets it through. Nothing else changes: a saved reply with no session match stays an automated notice, and a job session's saved row stays quiet.

Secondary change: a queue row that ended up in the quiet feed used to be labelled as if the tone gate had delivered it. It is now labelled "quiet-recorded", which is what happened.

## The safeguards

**A job cannot gain reply standing.** The proof of authorship is the fingerprint of the session's credential, which only that session's own environment holds and which the server checks against what it issued. Whether that session is a job is read from the server's session record, never from the row. A job's own saved reply therefore attributes to the job and stays quiet, as before.

**A saved reply without proof stays quiet.** No fingerprint, an unknown fingerprint, or an ended session means no session label, and no session label means no reply standing. The final check before sending refuses reply standing to any imported record that names no session, even if the sealed record claimed otherwise.

**The scope recovery runs in cannot change the answer.** A row's standing comes from the row's own attribution, not from whatever notification context the recovery loop happens to be running inside.

## What ships when

One pull request: the two conditions, the label fix, and three tests covering a session row that sends, a job row and two unattributed rows that stay quiet with the honest label, and a forged reply claim that is refused.

## What you actually need to decide

Nothing beyond merging: this restores the behaviour a direct reply already has, and leaves every quiet path exactly as it is.
