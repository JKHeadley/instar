# Sessions use the sign-in key where Instar says to put it — plain overview

**What was wrong.** Instar has two places in its settings file where the Claude sign-in key can go: an older single field, and a newer "credentials" section that the documentation recommends. Most of Instar reads the newer section, but the code that actually starts a Claude session only read the older field. If you put the key in the recommended place, Instar thought everything was fine, but every session started with no key and Claude replied "Not logged in". We hit this on the first Instar agent running on a rented cloud server, where a sign-in key is the normal way to sign in, because the server has no browser login.

**What changes.** When Instar starts a session it now looks for the key the same way the rest of Instar already does: the newer credentials section first, the older field if the newer one is empty. The same goes for the optional custom server address. Installs that only use the older field behave exactly as before.

**What does not change.** No settings move, no files are rewritten, no new questions are asked, and nothing is sent anywhere new. Each machine still reads only its own settings.

**Safeguards.** If the newer section holds something that is not a plain key (for example a placeholder for a value kept in the encrypted store), it is ignored rather than turned into a broken key. A test reproduces the exact failure from the cloud server: it fails without the fix and passes with it.

**If it were wrong.** Undoing the change brings back the old behavior. Nothing else needs repairing.

**What you need to decide.** Nothing. This is a bug fix that makes the documented setting work.
