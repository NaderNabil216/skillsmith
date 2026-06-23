---
name: commit-suggest
description: Use when writing or improving a git commit message for staged changes.
---

# Commit Suggest

Produce a clear, conventional commit message for the currently staged changes.

## Steps

1. Inspect what is staged — do not invent changes:
   - `git diff --staged --stat` for the shape of the change
   - `git diff --staged` for the actual content
   - If nothing is staged, tell the user and stop (offer `git add -p`).
2. Look at recent history to match the repo's style:
   - `git log --oneline -10`
   - Detect whether the project uses Conventional Commits (`feat:`, `fix:`…),
     ticket prefixes, or plain sentences, and follow that convention.
3. Write the message:
   - **Subject**: imperative mood, ≤ 50 chars, no trailing period.
     e.g. `fix: prevent crash when config is missing`
   - **Body** (only if the change isn't trivial): wrap at 72 cols; explain the
     *why*, not the *what* (the diff already shows the what).
   - Reference issues/tickets if the branch name or history implies one.
4. Present the message in a fenced block and ask before committing. Do not run
   `git commit` unless the user confirms.

## Rules

- One logical change per commit. If the diff mixes concerns, say so and suggest
  splitting it rather than writing one vague message.
- Never fabricate a ticket number or co-author.
- Keep the subject scannable; push detail into the body.
