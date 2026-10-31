# Feedback executor generated output

A feedback builder can produce a good draft and still be stopped if the project's own checks leave extra files behind. The executor now recognizes six specific generated files and leaves them out of the proposed PR. It still notices changes to files that already existed and any other new source file. The draft must still pass the normal review and merge checks.
