# ELI16: telling the agent a computer is gone for good, and one alarm for the whole agent (SEC-170, part 3 of 3)

The agent's computers share one limit on wrong PIN guesses: 20 every 5 minutes for the whole agent, split between them. When a computer is retired, the others only get its share back once that computer confirms it has stopped. A computer that was wiped, lost or destroyed never answers, so its share stays locked away.

This part lets you settle that. The agent keeps one list of computers it has not heard from in 7 days or more. For each one you can say "It's gone for good". You confirm that on your phone with Face ID, because only you should be able to make that call. Even then, the agent waits until none of its computers has heard from that one in 7 days. A computer that is really still running can never get its share handed out from under it. If you dismiss the list, it stays quiet until something new happens: another computer goes quiet, or a quiet one starts holding the limit back.

The second piece is one alarm for the whole agent. With each computer holding only a few guesses, someone could try a few at each address and stay under every single computer's alarm. Now the computers compare notes. If 20 wrong guesses land across all of them within an hour, one of them, never all of them, sends you the usual "someone is guessing your PIN" warning.
