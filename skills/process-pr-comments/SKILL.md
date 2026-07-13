---
name: process-pr-comments
description: Full PR/MR review-comment workflow for GitHub, GitLab, and Bitbucket. Use whenever the user wants to process, address, or work through pull- or merge-request review comments — e.g. "process PR comments", "address review feedback on PR/MR 123", "apply PR review comments", "work through MR X". Detects the forge (CLI-first, REST fallback), sets up the branch, scores unresolved comments against the actual code, gets per-comment approval (or one-shot auto-apply), plans and implements fixes, suggests a commit message, and (advanced) extracts reusable rules.
---

# Process PR / MR Review Comments

End-to-end workflow for addressing unresolved review comments on a **GitHub PR, GitLab MR, or Bitbucket PR**. Forge-agnostic: a small per-forge cheat-sheet supplies the few commands that differ. Use the term **PR** for GitHub/Bitbucket and **MR** for GitLab in all user-facing text.

## Modes

Usage: `process-pr-comments [pr-number] [simple|advanced] [review|auto]`

- **Scope** — **simple** (default): resolve → fetch → score → decide → implement → commit. **advanced** (the words "advanced", "deep", or "thorough"): also extracts reusable rules, validates design comments against the design tool, and offers a REST fallback when no CLI is present.
- **Per-comment handling** — **review** (default): each comment is presented for approval. **auto**: valid comments are applied without per-comment approval, gated only by the plan (step 6).

Steps tagged **[advanced]** are skipped in simple mode. Ask for the PR number and both mode choices in one prompt (step 1).

## Working fast

Run independent calls together in one message; put slow commands (fetch, merge, validation build) in the background and join before the step that needs them. Never background approval prompts or file edits.

## Forge cheat-sheet

Prefer the official CLI (`gh` / `glab` / `bb`). Without one, call the same REST endpoints and filter with `jq` so only the needed fields enter context. **Always pass the explicit PR number** — never a bare command that defaults to the current branch.

| Forge | Meta | Unresolved comments |
|---|---|---|
| **github** (`gh`) | `gh pr view <n> --json title,body,headRefName,baseRefName,reviewRequests,url` | GraphQL `reviewThreads` where `isResolved==false` + `gh api repos/{o}/{r}/issues/{n}/comments` |
| **gitlab** (`glab`) | `glab mr view <n> -F json` | `glab api projects/:id/merge_requests/:n/discussions` — notes where `resolvable && !resolved` |
| **bitbucket** (`bb`/REST) | `GET {BASE}/pull-requests/{n}` → `fromRef`/`toRef`/`reviewers` | `GET {BASE}/pull-requests/{n}/activities` — keep `action=="COMMENTED"` state `OPEN` (tasks: `severity=="BLOCKER"`) |

**[advanced] REST fallback (no CLI):** use a token from an env var (`GH_TOKEN` / `GITHUB_TOKEN` / `GITLAB_TOKEN` / `BITBUCKET_TOKEN`) in the auth header — GitHub `Authorization: Bearer` + `Accept: application/vnd.github+json`, GitLab `PRIVATE-TOKEN`, Bitbucket `Authorization: Bearer`. Never `echo` a token (it leaks into the transcript). If none is set, ask the user for a token or to paste the PR details and comment threads by hand. **Bitbucket = Server / Data Center only** — Bitbucket Cloud uses a different API and is unsupported; confirm the REST base URL with the user.

## Steps

### 1. Resolve inputs & context

**Ask once, up front** (single prompt): the **PR/MR number** — mandatory, never inferred from the current branch — and the **mode** choices (scope + per-comment handling). Then:

- **Detect the forge** from `git remote get-url origin`: `github.com` → github, `gitlab.com` or self-managed → gitlab, a Bitbucket host → bitbucket. Strip a trailing `.git` and any `user@`. Anything else → ask the user.
- **Access:** run `command -v gh` / `glab` / `bb` and check auth (`gh auth status`, `glab auth status`). If a CLI is present and authenticated, use it. Otherwise fall back to the **[advanced] REST fallback** above.
- **Fetch PR metadata** via the cheat-sheet and extract: title (parse a ticket id — `[A-Z]+-[0-9]+` Jira or `#NNN` issue ref), source branch, target branch, description, and reviewers.

Everything else is looked up **only when first needed**, not now:
- **Conventions file** (used for scoring in step 4) — first match of `AGENTS.md`, `CLAUDE.md`, `.claude/CLAUDE.md`, `.github/copilot-instructions.md`, `.cursorrules`, `CONTRIBUTING.md`; none → fall back to general best practices.
- **Validation command** (used in step 6) — inferred from `package.json` / `build.gradle(.kts)` / `Makefile` / `Cargo.toml` / `pubspec.yaml` / `Podfile`. Prefer a command the conventions file prescribes.
- **`commit-suggest` skill** (used in step 7) — `.claude/skills/commit-suggest/SKILL.md` locally or under `$HOME`.

### 2. Set up the branch

Checkout the source branch if not already on it (tell the user inline, no confirmation), then fetch and merge the target so a stale branch doesn't hide conflicts:

```bash
git fetch origin && git merge origin/<target-branch>
```

A clean merge auto-creates a merge commit — expected; do not push. May run in the background alongside step 3; join before step 4. On conflicts: show `git diff --name-only --diff-filter=U`, ask whether to resolve them for the user or let them do it; if resolving, follow the conventions file, then `git add <files> && git merge --continue`.

### 3. Fetch unresolved comments

Via the cheat-sheet, fetch all **unresolved** threads and filter every response before it enters context (CLI `--json`/`--jq`, or `curl | jq`; REST fallback follows the forge's pagination). For each thread, walk the full tree and capture:

- **author + body** of the original comment **and each reply** — the real request is often in a reply.
- **anchor** — `path` + `line` for inline comments; none for general ones.
- **open tasks** where the forge has them (Bitbucket `severity=="BLOCKER"`).
- Skip bot / system comments.

**Early exit:** if nothing is unresolved, make sure any background merge finished cleanly, then report *"No unresolved comments found on <PR|MR> #{n} — nothing to address."* and stop.

### 4. Score & validate each comment

Score every comment **1–5** and **validate against the actual code — never on comment text alone** (this holds in auto mode too; auto is not blind-apply):

| Score | Meaning |
|---|---|
| 5 | Critical — architecture violation, correctness bug, or security issue |
| 4 | High — significant quality or maintainability problem |
| 3 | Medium — style / naming, or a clearly valid improvement |
| 2 | Low — subjective preference or minor nit |
| 1 | Invalid — misunderstanding, outdated context, or factually wrong |

For each comment, `Read` the referenced code (inline: around the anchor line, ±~10 lines — never whole files; general: locate the area) and decide whether the issue genuinely exists or is already handled / outdated / a misread. If the code contradicts the comment, score **1** and note why. Keep the snippet — step 5 reuses it. If a conventions file exists, `grep` it for keywords relevant to the comment and read only the matched sections (never the whole file). Sort by score descending, number locally `1…N`, and refer to comments only as `Comment #N` (never the forge's internal id). This step is internal — no user-facing output yet.

**[advanced] Design comments:** for comments about visual correctness (spacing, padding, color, typography, sizing, alignment, layout, or that name a screen / mockup), validate the implementation against the design tool (e.g. Figma MCP). If it's unavailable, tell the user and ask them to connect it; if the exact screen can't be resolved, ask for its URL. Fold the result into the score and evaluation.

### 5. Present & decide

**review mode (default):** work through the sorted comments in **batches of up to 4** (highest score first). Print each comment as a full message — not inside the picker, so nothing truncates:

```
─────────────────────────────────────────────
Comment #<N> of <total>  [Score: <X>/5]  ·  <author>
File: <path> (line <line>)        ← omit if no anchor
Thread: <e.g. "2 replies · 1 open task">   ← omit if none

<author>: "<original comment>"
  ↳ <reply-author>: "<reply>"      ← one line per reply, in order; omit if none

Code (<path>:<line>):
> <diff-style snippet — anchored line marked, ±5 lines of context>   ← omit if no code location

Evaluation: <2–3 sentences: what the real code does and whether the comment holds. If there are replies, name who said what and conclude who's right and why — grounded in code / conventions / the design, not seniority.>
Suggested reply: <short, courteous, plain English — acknowledge if valid, or explain why if already handled / outdated / wrong>
```

For score **1**, add a `Validity issue: <reason>` line directly above the suggested reply. Then ask for decisions on that batch with a multiple-choice prompt — one question per comment, up to 4 per call, options **Apply** / **Skip** (the auto-appended "Other" choice covers "apply with this modification, typed inline"). Track `approved` and `skipped`, and continue batch by batch. Suggested replies are demonstration-only — **never post anything to the forge.**

**auto mode:** skip the per-comment prompts. Decide automatically (score 2–5 → apply, score 1 → skip) and print one compact summary table — columns: local `#` · score · `path:line` (or `general`) · author · ≤10-word gist · decision (every skip carries a brief reason). Print suggested replies only for the skipped (invalid) comments. Then go straight to step 6 — the plan is the only gate.

### 6. Plan & implement

Summarize the approved list (score-ordered), then produce a detailed implementation plan and get approval **before editing** (Claude Code: `EnterPlanMode` → `ExitPlanMode`):

- Order by score, group changes that touch the same file. Per comment: the exact file(s), the nature of the change, and which conventions rule it satisfies (if any).
- End with a validation step using the project's build/lint command (detect it now if not already found; run it in the background).
- **auto mode:** also list the auto-skipped invalid comments with their reasons, so nothing disappears silently.

**Plan approval is the last gate.** Once approved, implement everything and flow straight through step 7 (and step 8 if advanced) — don't stop to ask whether to continue. Never commit without explicit instruction.

### 7. Commit message

Suggest a commit message: if the `commit-suggest` skill is available, invoke it; otherwise compose one following the project's commit conventions (guidance in the conventions file, or `how_to_write_commit_messages.md` at the repo root).

### 8. [advanced] Extract rules & learn

Turn what was processed into durable rules so the same comments don't recur.

- **Derive** concise, checkable rules from the applied comments (and the invalid ones + their replies) — the underlying principle, not the one-off fix (e.g. *"Composables must accept `modifier: Modifier = Modifier` as the first optional parameter"*). Skip anything already documented. If a reviewer repeatedly enforced a pattern that's absent from the conventions file, flag it as a candidate.
- **Confirm** the candidates with the user before writing anything — never write unapproved rules.
- **Write** approved rules to a single cumulative `docs/pr-review-rules.md` (create it if missing), under a dated / PR-tagged heading, de-duped against what's already there.
- **Point to it** from the conventions file (priority `AGENTS.md` → `CLAUDE.md` → `.github/copilot-instructions.md` → cursor rules) with one idempotent pointer line. If that file already prescribes its own extraction method, route new rules into `docs/pr-review-rules.md` and point to it rather than duplicating inline. If editing the file triggers a "sync to other repos" mandate, copy it only to real, resolvable paths; otherwise print a one-line manual-sync reminder.
