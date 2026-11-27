# ELI16: the agent's settings API can't redirect where sessions run or talk (SEC-145)

The agent has a settings API that its own tools and sessions can call to change some settings. A few settings are too powerful for that, because they decide which program the agent actually runs, so they can only be changed in the settings file on the machine itself. That list already covered the Claude program path and two related settings.

It missed some of the same kind. One chooses the terminal program every session runs inside. Others choose the internet address every Claude session sends its conversation to, and the key and account it uses. Anyone who could call the settings API could point those somewhere else. The address change could reach new Claude sessions straight away, and the program choice after the next restart, so sessions would run a program of their choosing or send everything to a server they control.

Now those settings are on the same protected list. Changing them still works, but only by editing the settings file on the machine, which is an act of the person who owns it. Nothing the agent's own tools do today uses the API to change them, so nothing stops working.
