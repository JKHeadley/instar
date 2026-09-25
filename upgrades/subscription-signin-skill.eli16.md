# The standard sign-in procedure — plain-English version

Every Instar agent that uses Claude Code or Codex subscriptions needs those sign-ins to keep working. They expire every so often, and until now each agent figured out how to fix that on its own. Different agents re-learned the same lessons, and the scripted approach was brittle.

This change gives every agent one short, written procedure (a "skill") built from what actually worked on real accounts. It says:

- Each Google account gets its own Chrome profile on each machine, and that profile stays signed in to Google. When Google asks to sign in again, the agent types the account's password and its 6-digit authenticator code from the encrypted vault, in the same normal browser, so the Google side needs no person either. Adding an authenticator to an account is a change to its 2-step settings, so the agent asks the person once before doing it.
- Sign-ins always happen in a normal Chrome window, never a remote-controlled one, because the sign-in sites block remote-controlled browsers and let normal ones through.
- When an account needs signing in, the agent first looks at what is already known, lets the built-in automatic repair run, and then confirms the right account is active again.
- If the repair stops, there is a short table saying what each outcome means and what to do, including the two cases learned today: accounts whose authenticator is on a phone use a saved backup code, and a Mac that hasn't allowed the agent to control Chrome needs one setting turned on. For example: a picture puzzle or phone check always goes to the person, and a Chrome window that is already open is left alone.
- Hard lines: never solve a CAPTCHA, never pick a different account, never put passwords or codes in chat, never copy a browser profile or login between machines.

It is a skill, not a program: the agent follows it with its own judgment on whatever page it sees. It is kept deliberately short, and it gets a new row whenever a real sign-in teaches something new. Existing agents receive it automatically on update. Nothing needs deciding for this piece.
