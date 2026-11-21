# ELI16: your phone's Face ID key is set when you pair it (SEC-142)

Your phone keeps a special key that only works after Face ID. The agent uses it whenever it needs to know it's really you on your phone.

Right now the phone sends that key separately, some time after you pair it, and the first one to arrive is accepted. Only the Instar app itself can use your phone's keys, so the only thing that could send a fake one is harmful software running as the app. Software like that could also fake anything the app shows you, so no check inside the app can catch it.

What this change does: the app sends its Face ID key in the pairing request itself, so it is set by the same approval you already give when you pair, with no gap afterwards for anything to slip in, and no extra step for you. The agent also shows you when a key was set some other way.

What it can't do: stop harmful software that is already inside the app when you pair. Only Apple and Google can prove a key came from the genuine app, using a feature called attestation. Whether to add that is a separate decision for Justin.
