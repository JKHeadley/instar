# Security notices the cleanup could have closed by mistake

Instar's attention list now closes old notices nobody touched, but it never closes security notices. It decides what counts as security by looking for certain words. Two real security notices slipped past those words. One asked to change a key whose name was written as a single word ("github_token"), so the word "token" was not found on its own. The other warned that a machine still had access to someone else's email, and used none of the words the check looked for.

The check now also catches a secret's name inside a longer word, the word "OAuth", and "authorization for someone else". Before changing it, every one of the 4,522 notices across the four machines was re-checked with the new rule. It picked up exactly those two notices and nothing else, so ordinary notices still age out as before.
