# Upgrade Guide for Local History Preview Prerequisites

## What Changed

A private worker can calculate preview counts from verified conversation files. The store can check the destination for messages already copied and track ownership of temporary files for future copy work.

## What to Tell Your User

The local history preview is still being connected to the Mac app. This checkpoint adds internal preparation and recovery safeguards.

## Summary of New Capabilities

There is no new control to use.

## Evidence

Focused tests cover worker shutdown, preview counts, malformed artifacts, and private temporary ownership. The copy flow and installed app acceptance are still in development.
