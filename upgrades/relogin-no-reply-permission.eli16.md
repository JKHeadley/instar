# Sign-in repair recognises a waiting "Allow" prompt — plain-English version

The first time an agent tries to control Chrome on a Mac, macOS shows a question: "allow … to control Google Chrome?". Until someone clicks Allow, Chrome won't respond to the agent at all. On the Mac Mini the agent runs as its own Mac user, so that question sits on a screen nobody is looking at. The sign-in repair used to wait 30 seconds, give up, and try again, three times, and then just say it failed.

Now, when Chrome is clearly running but never answers, the repair stops on the first try and tells the person exactly what to do: on that machine, as the Mac user the agent runs as, click Allow on the prompt, or turn it on in System Settings, then tap "Try repair again". It's a one-time step per machine.

Nothing needs deciding.
