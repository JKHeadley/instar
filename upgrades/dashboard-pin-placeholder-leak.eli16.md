# Your dashboard message will never show "check your config" instead of your PIN

When your agent sets up a web dashboard you can open from your phone, it posts a
small pinned message in a "Dashboard" topic with the link and a 6-digit PIN you
type to log in. That PIN is kept in the agent's private, encrypted vault and is
unlocked when the agent's server starts up.

If the server happened to restart while the computer was under heavy load, that
unlock could briefly fail — and when it did, the pinned message printed the
words "check your config" where your PIN should have been. That text is a
leftover internal note; it isn't something you can do anything with (you don't
have access to the agent's config file), and worse, the dashboard link it came
with was unusable because you had no real PIN to type.

This fix makes the dashboard message careful about that. When it goes to post
your link, it first tries the PIN it already has; if that's missing, it reaches
back into the vault and reads your real PIN right then, which recovers from the
brief startup hiccup. And if — for some reason — it truly can't find your PIN in
that moment, it now simply leaves the PIN line out and tells you "ask me for
your dashboard PIN and I'll send it," instead of pasting in placeholder text.

The short version: your dashboard message will always show either your real PIN
or a plain "just ask me for it" — never confusing leftover wording in place of
the code you need to log in.
