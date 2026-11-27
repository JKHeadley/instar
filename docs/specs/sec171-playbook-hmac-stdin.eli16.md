# ELI16: the playbook signing key stays out of the list of running programs (SEC-171)

The agent signs its playbook, its saved know-how, with a secret key kept in the Mac's keychain. The small script that saves that key used to put the key itself into the command it ran.

Anyone else logged in to the same Mac can see every running command, so for a moment they could have read the key.

Now the script hands the key over through the command's private input instead, the same fix the agent's other keychain saves received. The keychain stores exactly the same thing, and a failed save is still reported.
