# Keeping the useful part of a setup error

When a feedback fix attempt fails during setup, the system saves the error so someone can work out why. It kept only the first 300 characters. Git commands start with a long list of safety flags, so those 300 characters were all flags, and the part saying what went wrong was thrown away. The step name came from the same shortened text, so it just said "other". Earlier today an attempt failed this way, and nobody could tell from the record whether a server restart had killed it.

Now the record keeps the beginning and the end of the error, and it works out the step from the whole message. If a command was killed, the record names the signal, which can show a restart was responsible. The text still goes through the same secret scrubbing and stays small. This only changes what gets recorded: the attempt fails the same way and counts the same. Nobody has a decision to make, and undoing it is a plain revert.
