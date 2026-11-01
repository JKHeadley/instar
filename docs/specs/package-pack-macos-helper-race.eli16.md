# Keep macOS package tests from failing on temporary helpers

During the full test suite, one macOS test creates and removes small helper programs inside the folder that another test packages. Packaging can spot a helper just as it disappears and report a missing file. This is a test timing race; the released package does not use those helpers.

The package test had a retry rule for this error, but its quiet npm setting hid the error details, so the rule could not recognize the helper. The test now lets npm show errors and allows up to 17 attempts for that one missing-helper case. Any different packaging error still fails immediately. This gives the temporary helper test time to finish without hiding a real package problem.
