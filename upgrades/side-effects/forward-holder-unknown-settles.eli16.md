# Plain-language overview: replies the other machine couldn't confirm

When I run on more than one computer, only one of them (the "serving" machine) is allowed to post to Telegram. If another machine writes a reply, it hands the reply to the serving machine to post.

Sometimes the serving machine sends it and then can't tell whether Telegram actually received it, for example when the connection drops right after the message goes out. In that case it never tries again, because trying again might post the same reply twice.

The problem was on the other machine. It kept asking the serving machine "did it get through?", heard "can't tell", and treated that the same as "the serving machine isn't answering". So it kept the reply marked as held and waited, for up to six hours. Those held replies then showed up on the dashboard as something wrong, and when the six hours ran out, the system even described them as "never sent, safe to resend", which could have caused a duplicate.

Now, when the serving machine says "can't tell", the other machine records exactly that: the reply may or may not have arrived, and it must not be sent again. The reply stops counting as held right away, the warning for that conversation clears if nothing else is waiting, and anyone asking "did it arrive?" gets the honest answer: unknown, don't resend.

What stays the same: if the serving machine really can't be reached, the reply still waits, because then nothing is known. Nothing is ever sent twice by this change; it only changes how an already-finished, uncertain send is recorded. There is nothing to approve here; it is a narrow fix to how one cross-machine case is recorded.
