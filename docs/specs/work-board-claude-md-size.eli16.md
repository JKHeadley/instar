# Keeping the agent's instruction file under its size limit — Plain-English Overview

> The one-line version: the Work Board text pushed the agent's always-loaded instruction file just over its size limit, so most of it moved into the look-it-up-when-needed reference files.

## The problem in one breath

Every agent session loads one instruction file. It has a size limit of 80,000 characters so that sessions stay fast and there is room for the agent's own notes. The main line was already close to the limit, and the Work Board instructions added about 780 characters, which took a freshly set-up agent to 80,009 characters, just over. A test caught it.

## What this changes

The step-by-step Work Board instructions now sit in the reference files the agent reads when the topic comes up, next to the other approval and commitment features. The always-loaded file keeps a short question-to-answer row and a one-line reminder: open a card when you need a person's decision, and only a person's tap approves one. A fresh agent's file now measures 79,540 characters, 460 under the limit.

## The safeguards

The limit itself did not change. The never-approve rule is still in the always-loaded file in short form and in full in the reference file. Reverting the commit undoes it.
