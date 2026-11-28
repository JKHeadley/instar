# Retiring "one Telegram topic per alert" (ELI16)

When the agent needs your attention, it used to be able to open a brand new Telegram topic for every single alert. That filled people's chat lists with dozens of topics. Since July, every alert goes into one shared "Attention" topic instead.

An old switch could still bring back the one-topic-per-alert behaviour. It was kept only so older setups could roll back, but nothing stopped new work from using it, and nobody had said when it would go away. Now the switch has an end date: it keeps working until 1 March 2027 and prints a warning every time the agent starts on a setup that still uses it. After that date the agent ignores it and uses the one shared topic. A check in the tests makes sure nothing in the code turns the old mode on, and the agent's own instructions now say the mode is retired instead of explaining how to use it.
