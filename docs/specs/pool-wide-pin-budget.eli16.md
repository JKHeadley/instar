# ELI16: one limit on PIN guesses for the whole agent (SEC-170)

The agent's dashboard is protected by a PIN. If a stranger guessed it, they would get the agent's master key. To stop guessing, the agent allows unknown browsers only 20 wrong tries every 5 minutes.

The catch: the agent can run on several computers, and each one kept its own count of 20. All of them check the same PIN. So a stranger who found four of the agent's addresses could try 80 times every 5 minutes instead of 20.

The fix splits the 20 between the computers. With five computers, each one allows 4 wrong tries every 5 minutes, so even a stranger who knows every address gets 20 in total. Each computer counts its own tries, so nothing has to travel between computers when someone types a PIN, and a computer that is cut off from the others keeps working within its part.

The owner keeps every normal way in. A browser they have unlocked before, their phone app and the computer itself all work instantly, even during an attack. Signing in from a brand-new browser takes one or two tries, which fits inside any part. If an attacker uses up one computer's part, a new browser waits a few minutes on that computer only; the others are unaffected.

When a computer is added, the computer that added it hands over some of its own part straight away, and the new one can be used after 5 minutes. The parts are evened out once every computer has agreed. When a computer is retired, the others get a bigger part only after it confirms it has stopped, or after the owner confirms from the phone that it is gone for good.

This is switched on for the development agents first. It reaches everyone else only after a week of evidence that it works, and with Justin's go-ahead.
