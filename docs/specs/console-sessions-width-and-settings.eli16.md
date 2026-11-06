# The Sessions page uses the window, and gets a Session settings button: plain overview

Justin looked at the console's Sessions page on his desktop and wrote two things. First, "the columns are way too squeezed here. we should make better use of whitespace". The list sat in a narrow strip in the middle of the screen, the page's headline wrapped over five lines, and the right side held one small line of text with nothing around it. Second, "there should be a session settings clear button where I can change default settings such as default doorway and model". Those defaults did exist, but only behind a small link inside the New session form, so you had to start making a session to find them.

This change fixes both. On a desktop, the Sessions page now uses the width of the window: the list is wider, the headline fits on one line, and when no session is open the right side shows a full-height empty panel instead of a stray sentence. When a session is open, its terminal takes the rest of the width as before. On a phone nothing moves: it is still one column.

Next to "+ New session" there is now a "Session settings" button. It opens just the defaults: the default door and the default model that new sessions start on, with Save and Clear. It runs the same route the old link used, with the same rules, so nothing new is allowed. The New session form still has the defaults for anyone who looks there. The iPhone app gets the same button on its sessions list, a gear next to the "+", and its New session sheet now points to it instead of repeating the form.

Justin also asked whether "door" should be renamed, and the coordinator suggested "Engine". He hasn't confirmed a word yet, so the word does not change here. Instead, each place a person reads the word now takes it from one constant, one each in the console, the server's phone answers and the app. When he picks a word, the rename is a one-line change on each side. Tests fail if a new sentence spells the word out instead of using the constant.

What you need to decide: the word itself, when you're ready. Reverting this change puts the page back as it was.
