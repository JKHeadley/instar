# Locked-Mac proof harness: drive the viewer as it really behaves

## What this is

Before Instar may open any locked Mac, we prove it on a spare Mac with a throwaway user. A script (the "driver") plays the owner: it opens Instar's real desktop page in a browser, asks for access, and types the throwaway user's password into the real password box. Three small scripts set up the two test agents beforehand. This change fixes three things the 4 November run on the Mac Mini tripped over. None of it touches the shipped product; these are test scripts only.

## What changes

**The driver waited for a button that never appears.** When exactly one machine is ready, the desktop page opens the remote screen by itself and keeps the "request" button hidden. The driver sat waiting for that button and gave up. Now the driver treats either outcome as "the page is ready": an enabled request button, or the remote screen already open. A new small step, "request a grant", clicks the button only when the screen is not already open. The three places that open a grant (the main grant, the attempt from the second agent, and the next grant after Stop) all use it.

**The test agents had no dashboard PIN.** The page needs the dashboard PIN, and the test agents (which have no Telegram) never got one. The setup script now reads a PIN from the operator's own secret vault and hands it to each test agent on standard input, so it is never printed, logged, or placed on a command line. If the vault has no PIN, setup stops and names the vault key to fill. This removes the harness's dependence on the server fix that gives every agent a PIN.

**The last setup step was easy to miss.** Setup has three steps in order: stage, start, finalize. Finalize makes each test agent its own "desktop front", and it can only run after the first start. Each step now prints the next one, the script's header lists them in order and marks finalize as required, and the driver refuses to start (naming the finalize command) while a test agent lacks its PIN or is not yet its own front.

## What you need to decide

Nothing. This is test tooling for the locked-screen proof.
