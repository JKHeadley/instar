# ELI16: confirm pages stop being a way to guess your PIN (SEC-135)

Some of the agent's pages let you say yes or no to something, such as setting up a Bitwarden backup, by typing your dashboard PIN. Anyone who knows the agent's web address can open one, because the page has to work before you sign in.

Each time the page was opened it got a fresh "page ticket", and each ticket allowed 5 wrong PIN tries. The agent handed out up to 30 new tickets a minute to anyone. A stranger could keep opening the page, take a new ticket each time and try 5 PINs on each: about 9,000 guesses an hour. A six-digit PIN had an even chance of falling in about two days.

Now a page answered from an unknown browser is treated exactly like the dashboard sign-in page. It has the same limits: slowing down after a few wrong tries, a cap per network, and a small shared allowance for the whole machine. So a stranger gets no more tries here than on the sign-in page, which the agent already protects. The even-chance time for a six-digit PIN goes from about two days to about eleven weeks, and you get an alert as soon as someone starts guessing.

Your own browser is not slowed down. A browser where you have unlocked the dashboard before carries a small signed marker, and it keeps its own allowance, so strangers can never use it up. The computer the agent runs on has its own allowance too, which strangers cannot use up. Even a flood of strangers opening the page cannot stop those two from opening it or push out a page they have open. The only time you would notice anything is on a browser you have never unlocked the dashboard in, while someone is actively guessing: the page then asks you to wait a few minutes or use one of your usual browsers, exactly as the sign-in page already does.

Justin approved this on 21 November 2026: he accepted that small waiting cost for a medium-rated issue, and chose the faster rollout. The fix runs on Echo first. As soon as it has been seen working through a real attack, from a remembered browser and from the computer itself, the maturation review decides, and the rest of the fleet gets it right after.
