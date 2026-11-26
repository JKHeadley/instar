# Saved secrets from Secret Drop show as one line, not long codes

The Secrets page in the dashboard lists the names of the secrets the agent keeps, never their values, so the operator can see what it already has. Most names are readable, like "github_token". But when someone sends a secret through a Secret Drop link, the agent keeps a durable copy under a name made from a long random code, sixty-four letters and numbers. Each of those showed up on the page as its own line of gibberish, which on a phone wraps across the screen and tells the operator nothing.

Now the page counts those entries and shows one line instead, such as "Saved Secret Drop submissions (2)". Every other name is listed exactly as before, and nothing about how secrets are stored or used changes. The list the agent reads for itself when it starts a session still has the full names, because the agent may need them; only what the operator sees on the page is tidied.
