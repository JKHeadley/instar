# ELI16: the computers agree before anyone's part of the PIN limit grows (SEC-170, part 2 of 3)

Part 1 split the agent's 20 PIN guesses between its computers, and let each computer's part only get smaller on its own.

Part 2 lets a part grow again, but only when every computer agrees. Every 30 seconds each computer asks the others for a short signed note saying which list of computers it is using and how big its part is. Only when every computer's note shows the same list, and five more minutes have passed, does anyone use a bigger part. A forged or replayed note is thrown away.

A newly added computer starts at zero. The computer with the lowest name that has a part to spare hands over half of it, and the new computer can use it after five minutes. A computer that loses its records does the same. A computer that is retired drops to zero and says so.

The owner's tap for "this computer is gone for good", and the single notice listing silent computers, come in part 3. Until then, a retired computer that never answers simply keeps the others' parts from growing, which is the safe side.
