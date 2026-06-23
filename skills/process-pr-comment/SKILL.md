---
name: process-pr-comment
description: Use when triaging, responding to, or resolving review comments on a pull request.
---

# Process PR Comment

Work through review comments on a pull request methodically, turning each one
into either a code change, a reply, or a resolved thread.

## Steps

1. Gather the comments (prefer the `gh` CLI if available):
   - `gh pr view <n> --comments` for the discussion
   - `gh api repos/{owner}/{repo}/pulls/<n>/comments` for inline review threads
   - Note for each: file, line, author, whether it asks for a change or a question.
2. Triage each comment into one of:
   - **Change requested** → make the edit.
   - **Question** → answer it (in the reply, and in code/comments if useful).
   - **Suggestion / nit** → apply if cheap and reasonable; otherwise explain.
   - **Out of scope** → acknowledge and propose a follow-up issue.
3. For each change you make:
   - Keep edits minimal and focused on the comment.
   - Reference the comment so the reviewer can connect change ↔ feedback.
4. Draft replies that are specific and respectful: state what you did (or why
   you didn't), and link the commit/line. Do not mark threads resolved unless
   the user asks — that's the reviewer's call by convention on many teams.
5. Summarize: list each comment, the action taken, and anything still open.

## Rules

- Address every comment — never silently skip one. If you disagree, say why.
- Don't bundle unrelated refactors into review-fix commits.
- Don't post replies or resolve threads without the user's confirmation.
- If a comment is ambiguous, ask the reviewer rather than guessing.
