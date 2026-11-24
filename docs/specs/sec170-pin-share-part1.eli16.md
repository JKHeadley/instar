# ELI16: each computer gets its part of the PIN guess limit (SEC-170, part 1 of 2)

The agent's dashboard PIN allows strangers 20 wrong guesses every 5 minutes. Until now each of the agent's computers allowed 20, so a stranger who knew every address got 20 per computer.

Now the 20 is split between the computers. With five computers, each allows 4. Each computer counts its own part and saves the count carefully, so a crash or power cut does not hand anyone a fresh start. If a computer cannot save its count, it says no to new browsers rather than letting more guesses through.

A computer's part can only get smaller on its own, for example when another computer joins. It never gets bigger without the other computers agreeing; that agreement comes in part 2.

The owner keeps every normal way in: a browser they unlocked before, the phone app and the computer itself. This is switched on for the development agent first.
