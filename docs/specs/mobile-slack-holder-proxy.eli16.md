# Remote Slack history on the phone: plain overview

Each machine numbers its Slack conversations on its own, so the number -7 on the Studio and -7 on the laptop can be two different conversations. The phone talks to one machine at a time. Until now, if the phone asked the Studio for a conversation held by the laptop, the Studio refused, because it can't answer for a number that isn't its own. So a Slack conversation on another machine could be listed but not opened.

After this change, the Studio fetches that history from the laptop for the owner's phone and passes it back. It only does that for a phone signed by the owner, and it checks the phone again after the laptop answers, so a phone revoked during the wait gets nothing. It finds the laptop only in the list of machines it already trusts, so nothing in the request can point it at another address. It refuses redirects and oversized answers, and gives up after eight seconds.

Other phones and token callers get the same refusal as before, which also stops a request from hopping on to a third machine. Sending a message is not forwarded at all; only reading is. An older machine that can't answer in the phone's format is refused instead of having its raw rows passed along.

One gap remains: files attached to a remote conversation will show but won't download yet. There is nothing to decide here unless that gap matters now.
