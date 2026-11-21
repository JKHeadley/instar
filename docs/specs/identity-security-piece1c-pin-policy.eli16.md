# One PIN rule everywhere, explained simply

Your dashboard PIN protects signing in and a handful of owner actions, like approving a request or changing a setting. Only the sign-in screen had proper protection against someone guessing. A few wrong tries there slow you down, lots of wrong tries from anywhere stop all guessing for a while, and you get an alert.

The other places that ask for the PIN were weaker:
- some had no limit at all;
- some counted everyone who reaches the agent over the internet as one person, so one stranger guessing could lock you out;
- each kept its own count, which a restart wiped.

This change puts one check behind every place the PIN is asked for, with two separate allowances.

- **The public allowance** covers places anyone on the internet can reach: the sign-in screen and approval links. Each visitor is counted on their own, there is an overall cap, and the cap survives a restart.
- **The signed-in allowance** covers the owner actions you can only reach after signing in. Each signed-in device or session has its own small limit, so a stranger guessing at the sign-in screen, or anyone else's mistakes, can never lock you out of your own actions.

If the agent's guess counts get damaged, it pauses PIN sign-in from the internet for five minutes, rather than letting guesses through, and then carries on. Your phone, a browser you've signed in with before, and this computer still work.

With the right PIN, nothing changes for you.
