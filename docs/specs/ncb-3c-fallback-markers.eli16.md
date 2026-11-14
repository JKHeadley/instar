# Telling the error checker where media errors go — Plain-English Overview

> The one-line version: four places in the new media code already report their errors, but the automatic checker could not see that, so each now says where its report goes.

## The problem in one breath

The project has an automatic check that counts places where code catches an error and carries on quietly. It only accepts such a place if the words "DegradationReporter" (the error-reporting service) appear right next to it. The new media code reports its errors through a small helper that hands them to that service, so the checker counted four of them as quiet and the count went over its limit.

## What this changes

Each of the four places now carries a one-line comment saying its error goes to the reporting service through the helper. Nothing the program does changes. The limit stays where it was.

## The safeguards

No behaviour, interface or limit changes. Removing the comments undoes it completely.
