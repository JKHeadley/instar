# A refused request is told plainly that the connection is closing (ELI16)

Earlier today the server learned to hang up after refusing a request whose body it never read, instead of reading whatever the sender kept sending. It did that by simply cutting the connection after its answer.

Some programs that sit in the middle, like the tunnel that carries traffic from the internet to the agent, reuse connections for several requests. When a connection is cut without warning, such a program can mistake that for a crash and show the person an error page instead of the server's actual answer.

Now the server also says "this connection is closing" in its answer before hanging up. Programs in the middle read that and close cleanly, so the person sees the real answer. Answers to requests whose body was fully read are unchanged.
