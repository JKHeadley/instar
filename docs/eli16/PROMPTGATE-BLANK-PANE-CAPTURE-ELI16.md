# PromptGate Blank Pane Capture ELI16

PromptGate watches the text that appears in a running terminal pane so it can answer only the small, known prompts that are already considered safe. For example, it can press Enter for the `npx instar` install prompt, or choose the reject option for a Gemini execution approval modal that should not run a command.

The bug was in the shape of the captured pane, not in the modal rules themselves. A normal terminal pane can be 50 rows tall. If Gemini prints a prompt near the top of that pane and the rest of the pane is empty, the capture still contains all those empty rows at the bottom. PromptGate was taking the last few rows of the capture before matching prompts. In a blank-filled pane, that meant it could look only at the empty bottom rows and miss the real prompt text above them.

The fix trims only trailing blank rows before applying the existing detection window. Interior blank lines are preserved, because some modals use blank lines as part of their shape. After trimming the terminal padding, PromptGate still looks at the meaningful tail of the pane and feeds the same prompt text to the same safe-default and safe-reject handlers.

This does not add a new kind of approval, a new command decision, or a wider authority path. It makes the existing detector see the modal text that was already on screen. The tests cover the default blank-filled pane shape that missed before, and the existing small-pane shape that was already working.
