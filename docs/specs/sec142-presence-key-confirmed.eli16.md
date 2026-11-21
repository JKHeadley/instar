# ELI16: your phone's Face ID key counts only after you confirm it (SEC-142)

Your phone keeps a special key that only works after Face ID. The agent uses it whenever it needs to know it's really you on your phone, for example to open the console without the PIN.

Right now, the first such key a phone sends to your computer is simply accepted. If harmful software got onto the phone before the real app sent its key, it could send its own key first, and from then on it would pass every Face ID check on that computer.

From now on, a new phone's Face ID key is confirmed by the same approval you already give when you pair the phone, so nothing extra is asked of you. For phones that are already paired, you check once: the app shows a short code made from its own key, the dashboard shows the code the computer has on record, and you tap Confirm if they match. If they don't match, the key on record isn't your phone's, and the dashboard helps you pair the phone again to remove it.
