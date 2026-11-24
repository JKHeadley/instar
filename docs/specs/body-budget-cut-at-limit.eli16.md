# A body that is too large is cut off when it passes the limit, and a device id alone opens less (ELI16)

Before anyone has signed in, the agent's server only reads a small amount of a request, so a stranger cannot make it swallow huge uploads. Two gaps remained.

First, when an upload did not say how big it was, the part that reads it noticed "too big" only after the whole upload had arrived. It kept reading until the sender stopped, and only then said no. Now the server counts as the bytes arrive and hangs up the moment the limit is passed.

Second, a phone the agent is paired with gets a larger allowance, but the phone is recognised at that point only by its id, which is not a secret. Anyone who knew the id could claim the larger allowance on any address. Now the larger allowance applies only to the addresses a phone is actually allowed to send to. The phone's real signature is still checked afterwards, as before.
