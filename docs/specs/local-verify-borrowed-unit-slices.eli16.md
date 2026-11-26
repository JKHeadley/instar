# Borrowed machines practise on the quick tests, and nothing they say counts yet (plain version)

Every change is tested on two of our machines before it merges. Justin has other machines that are often partly idle: his laptop, and an old Windows PC. He wants them to help, even while he uses them, and to step back the moment he needs them.

The first review showed two things. First, right now the quick tests are not what slows a run down, so a borrowed machine running them would barely speed anything up. Second, letting a borrowed machine's answers count would mean running other people's code on Justin's personal laptop. That needs strong walls first.

So this first step is **practice only**. A borrowed machine runs small slices of the quick tests, and its answers are compared with our own machines' answers, but they never decide anything. That tells us how fast and how reliable each machine really is, with no risk to the code.

**What keeps his machine safe:**

- The helper role is off unless the machine's own agent turns it on, and it tells the test-line session before it does.
- In this practice phase, it only ever runs code that has already been checked and merged, never anyone's unfinished change. The machine confirms that itself with GitHub before running anything.
- The tests never run on his laptop's own system. They run inside a small Linux virtual machine on the laptop, with its own fixed amount of memory and processor. It cannot see his files at all, cannot reach his other programs, his browser or other machines at home, and is wiped clean regularly. The laptop checks those walls every time before it starts. Setting it up needs one yes from him (his phone is fine), and one command removes it. On Windows, the same is done with a separate Linux system inside Windows.
- Tests that drive the Mac desktop, Chrome, the Codex tool or system services never go to a borrowed machine.

**What keeps him in control:**

- The virtual machine can never use more than half the laptop's cores or more than 8 GB of memory, and it always leaves 4 cores free for him.
- It steps back at once when he gets busy, when memory gets tight, or when the laptop goes on battery.
- He can press pause on the machine itself.
- On Windows, it only runs if it can see how busy Windows is.

**Also included:** we start recording how long each quick test takes. Every later speed-up needs that.

**What comes next:** after about 20 practice runs, I report the speed, the agreement and any slowdown he noticed. Letting answers count would be a separate step, taken only if the numbers show it helps and only if he says yes.
