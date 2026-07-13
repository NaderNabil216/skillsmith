---
name: process-pr-comments-lite
description: Fast, autonomous version of process-pr-comments. Given a PR/MR number, it implements the review comments that are logically valid against the code, saves recurring feedback as reusable rules, and stops — no prompts, no approval gates, no commit, no commit-message step. Use when asked to quickly or automatically apply PR/MR review comments without user input, e.g. "process PR 123 comments lite", "auto-apply the review comments on MR X", "just fix the valid PR comments".
---

# Process PR / MR Review Comments — Lite

A stripped-down, autonomous take on `process-pr-comments`: given a **PR/MR number**, apply the review comments that are logically sound against the real code, record recurring feedback as rules, and stop. Nothing else.

For the full interactive workflow — batched per-comment approval, an implementation-plan gate, and a `commit-suggest` step — use **`process-pr-comments`** instead.

## Rules

- **No user input.** Take the PR/MR number from the request. Never ask questions, never wait for approval, never gate on a plan.
- **Never post to the forge** and **never commit.** Edit files in the working tree only — leave staging and committing to the user.
- **Only apply what's logically sound.** Validate every comment against the actual code; silently skip anything that's already handled, outdated, or wrong.

## Steps

### 1. Resolve & fetch

- Detect the forge from `git remote get-url origin` (github / gitlab / bitbucket) and use its CLI (`gh` / `glab` / `bb`), always passing the explicit PR number.
- Check out the PR's source branch if not already on it (`git fetch` first if the branch is missing).
- Fetch all **unresolved** comment threads, filtered to the needed fields (CLI `--json`/`--jq`). Walk each thread fully — the real request is often in a reply — and skip bot / system comments. If there are none, report *"No unresolved comments on <PR|MR> #{n}."* and stop.

### 2. Validate against the code

For each comment, `Read` the referenced code (inline: around the anchor line, ±~10 lines; general: locate the area) and decide whether the requested change is **logically correct** — a genuine fix or improvement that isn't already handled, outdated, or based on a misread. If a conventions file exists (`AGENTS.md`, `CLAUDE.md`, `.github/copilot-instructions.md`, `.cursorrules`), `grep` it for keywords relevant to the comment and read only the matched sections. Keep a one-line verdict per comment.

### 3. Implement the valid ones

Apply every comment that passed step 2 directly in the working tree, grouping edits by file. Skip the rest. Do not stage or commit.

### 4. Save the rules

Extract durable, checkable rules from what was applied — the underlying principle, not the one-off fix (e.g. *"Composables accept `modifier: Modifier = Modifier` as the first optional parameter"*). Append them to a cumulative `docs/pr-review-rules.md` (create it if missing), de-duped, under a PR-tagged heading. Add a one-line pointer to that file from the conventions file (priority `AGENTS.md` → `CLAUDE.md` → `.github/copilot-instructions.md` → cursor rules) if one isn't there already.

### 5. Report & stop

Print a short summary and end — no commit, no further steps:

- **Applied** — one line per implemented comment: `path:line — <gist>`.
- **Skipped** — one line per skipped comment: `path:line — <one-line reason>`.
- **Rules** — the rules written to `docs/pr-review-rules.md`.
