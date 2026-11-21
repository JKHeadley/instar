# ELI16: typing into a session from your phone asks for Face ID now and then (SEC-140)

From the Instar app you can type into a running session on your computer, press keys like Enter, and drop in files. Sessions can do anything on the computer, so typing a command into one is like running it yourself.

Today the app proves only that the request comes from your phone. It does not prove that you are the one holding it. Closing or moving a session already asks for Face ID, but typing a command does not. So if someone got hold of your unlocked phone, or harmful software ran on it, they could type commands into your sessions.

Now typing will need a short "go-ahead" that the phone gets with Face ID. One Face ID lasts while you keep typing: it stays good for five minutes after the last thing you sent, up to half an hour. So a normal back-and-forth asks at most about twice an hour. If the go-ahead has run out, the app shows the Face ID prompt and sends your message right after; if you cancel, your message stays in the box.

Older versions of the app keep working as today until they update. As soon as your phone's app has used a go-ahead once, that phone always needs one, so someone with a copy of its key cannot skip it. Later you can choose to require it for every phone.
