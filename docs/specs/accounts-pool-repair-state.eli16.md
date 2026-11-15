## The phone says "signing in now" when another machine is fixing a sign-in

The Accounts screen on the phone shows, for each account, whether it is signed in on each machine. When a machine's sign-in runs out, Instar tries to repair it on its own. But the screen only knew about repairs on the machine answering the phone, so a repair running on, say, the Mac Mini still showed up as a plain "needs sign-in". That made it look like the person had work to do when they did not.

Now the screen reads the repair list from every machine. While a repair is running it says "signing in now". If a repair is about to start on its own, or will try again shortly, it says so and is not counted as something for the person. If a repair failed and will not try again, it is counted and gives the plain reason, such as "the sign-in helper couldn't finish". If a repair needs the person's OK or a step only they can do, it says that.
