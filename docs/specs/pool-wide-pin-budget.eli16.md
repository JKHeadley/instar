# ELI16: one limit on PIN guesses for the whole agent (SEC-170)

The agent's dashboard is protected by a PIN. If a stranger guessed it, they would get the agent's master key. To stop guessing, the agent allows unknown browsers only 20 wrong tries every 5 minutes.

The catch: the agent can run on several computers, and each one kept its own count of 20. All of them check the same PIN. So a stranger who found four of the agent's addresses could try 80 times every 5 minutes instead of 20.

The fix makes the limit belong to the whole agent. One computer, the one currently in charge, keeps the count. Before any other computer checks a PIN from an unknown browser, it asks that computer for permission to try, and the try is counted straight away. If the guess was right, the count is given back.

If a computer cannot reach the one in charge, it simply says no to unknown browsers until it can. It never falls back to counting on its own, because that would let the total creep above 20. When a different computer takes charge, it first asks the previous one for its count and simply carries on. Only if the previous one has gone quiet does the new one say no to unknown browsers for a little over five minutes, because it cannot know how many tries were already allowed.

The owner keeps every normal way in. A browser they have unlocked before, their phone app, and the computer itself all still work instantly, even during an attack. One thing does change, and it is worth saying plainly: a stranger now needs only one of the agent's addresses to make brand-new browsers wait a few minutes everywhere. Before, they needed every address. That is the price of a real limit, and it is the same price a single computer already paid.

This is switched on for the development agents first. It reaches everyone else only after a week of evidence that it works, and with Justin's go-ahead.
