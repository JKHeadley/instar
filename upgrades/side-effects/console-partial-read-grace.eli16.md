# "Part of the list could not be checked" shows up far less

The dashboard's home screen collects what needs you from all of the agent's machines at once. If one machine is slow to answer for a moment, for example because it is busy or restarting, that one refresh comes back incomplete. Until now the home screen then replaced its answer with "Nothing needs you that I can see. Part of the list could not be checked." The dashboard refreshes often, so even a machine that only hiccups now and then made that warning appear regularly. It looked like the checks themselves were broken, even though the very next refresh usually succeeded.

Now, when one machine misses a refresh, the dashboard keeps showing what that machine reported the last time it did answer, as long as that was less than two minutes ago. Everything from the machines that did answer is still fresh. Meanwhile it keeps asking the missing machine again in the background. If the machine stays silent for more than two minutes, the warning comes back exactly as before, because by then it is a real problem worth telling you about.

So you only see "could not be checked" when a machine really is unreachable, not every time one is briefly slow.
