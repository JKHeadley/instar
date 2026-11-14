# Pairing code becomes a word plus four digits: the plain version

When you add an Instar agent to the Instar iPhone app, the app asks you for a short confirmation code. That code only goes to you: in your private Telegram chat with the agent, or on the agent's dashboard after you unlock it with your PIN. Typing it into the app proves the phone in your hand belongs to you, and not to someone who got hold of the pairing link.

The problem was that the code was six digits, and the dashboard PIN is also six digits. When the operator tried this on a new cloud machine on 2 November, the two numbers looked the same. He typed the PIN where the code belonged, and pairing turned into a confusing loop.

This change makes the code look different from any PIN. It becomes a word plus four digits, like KITE-4172. The word comes from a fixed list of 256 short, distinct words, so it is easy to read aloud and hard to mistype. There are about 2.5 million possible word codes. The limits on wrong guesses are unchanged: three per phone, and ten a day on each machine, then pairing pauses on that machine. Someone trying to guess can still ask for the old six-digit kind, so guessing is no easier and no harder than before; the change is about not mixing up two numbers. Capital letters, a space or a dash between the word and the digits do not matter when you type it. And if you type your PIN, or anything else that is not shaped like a word plus four digits, the app tells you so and it does not count as a wrong guess, because it could never have been the code.

Phones running an older version of the app keep getting the six-digit code, because only the updated app asks for the new kind. Nothing else about pairing changes. The link, who can approve, where the code is shown, and the rule that the agent never asks you for the code all stay the same.

Bigger ideas, like scanning a QR code on the machine instead of typing anything, were designed. They kept turning up new problems in review, so they were set aside for later and remain tracked as a commitment. This is the small, safe first step.

What to decide: nothing. It is reversible by undoing the change, and codes are never saved to disk, so nothing is left behind.
