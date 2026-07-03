---
name: process-pr-comments
description: Full PR/MR review-comment workflow for GitHub, GitLab, and Bitbucket. Use whenever the user wants to process, address, or work through pull- or merge-request review comments — e.g. "process PR comments", "address review feedback on PR/MR 123", "apply PR review comments", "work through MR X". Detects the forge (CLI-first, REST fallback), sets up the branch, scores unresolved comments against the actual code, gets per-comment approval, plans and implements fixes, suggests a commit message, and extracts reusable rules.
---

# Process PR / MR Review Comments

End-to-end workflow for addressing unresolved review comments on a **GitHub PR, GitLab MR, or Bitbucket PR**. The flow is forge-agnostic: a per-forge **Forge adapter** supplies the few commands that differ.

---

## Requirements & tool mapping

**Runtime:** `git` + POSIX shell. Prefer the forge's official CLI (`gh` / `glab` / `bb`); otherwise `curl` + `jq` (if `jq` is missing, use the CLI's `--json`/`--jq`, or extract the minimum by hand). Steps are written as capabilities; bind them to your harness (Claude Code bindings below; elsewhere substitute equivalents, falling back to a plain numbered question where no multiple-choice UI exists):

| Capability | Claude Code binding |
|---|---|
| multiple-choice question | `AskUserQuestion` (≤4 questions/call) |
| plan approval before editing | `EnterPlanMode` → `ExitPlanMode` |
| bounded file read · search · shell (backgroundable) | `Read` (offset/limit) · `Grep` · `Bash` (`run_in_background`) |
| parallel independent work | subagent (Agent tool) |
| optional live task list | `TaskCreate` / `TaskUpdate` |
| design-tool lookup | Figma MCP (`mcp__…Figma…`) or any design integration |
| commit-message helper | the `commit-suggest` skill (see 0E) |

---

## Progress checklist (show throughout)

**Print it once at the very start** (all pending, Phase 0 in progress) and **re-print the full tree only at the start of each phase**; within a phase a one-liner like `Phase 3/7 ▸ filtering comments` is enough. Mark finished `[✓]`, current `← in progress`, rest `[ ]`; a parent is `[✓]` only when all sub-phases are.

```
**<PR|MR> #<id> — progress**
- [ ] Phase 0 — Project context
  - [ ] 0A Detect forge & repo coords
  - [ ] 0B Access (CLI or token)  ← in progress
  - [ ] 0C Conventions file
  - [ ] 0D Build/validation command
  - [ ] 0E commit-suggest skill check
- [ ] Phase 1 — Change-request details (title/ticket, branches, description, reviewers)
- [ ] Phase 2 — Branch setup
  - [ ] Checkout source branch
  - [ ] Fetch + merge target (resolve conflicts if any)
- [ ] Phase 3 — Fetch unresolved comments
  - [ ] Fetch threads via forge adapter
  - [ ] Filter to unresolved + walk thread tree
- [ ] Phase 4 — Score, present & decide
  - [ ] Score & code-validate all (internal)
  - [ ] Present & decide, batch by batch
- [ ] Phase 5 — Implementation plan (draft → approval)
- [ ] Phase 6 — Commit message
- [ ] Phase 7 — Extract rules & learn
  - [ ] Derive & confirm candidate rules
  - [ ] Write to docs/pr-review-rules.md
  - [ ] Pointer in agent-instructions file (+ sync handling)
```

Omit `<id>` until Phase 1 resolves it. Keep the list to phases + sub-phases (don't expand Steps 1–22). On early exit (e.g. no unresolved comments), print reached items `[✓]` and strike the rest `~~…~~ (skipped)`. You may mirror into a harness task list, but the printed checklist is what the user reads.

---

## Concurrency & background (speed)

Overlap work with no data dependency: issue independent tool calls **in one message**, use **background Bash** for slow commands, fan out subagents only when warranted. This section is the single home for these rules — phases just reference it.

- **Phase 0 detections** — 0A, 0C, 0D, 0E are independent local checks; run as parallel calls in one message.
- **Phase 2 ∥ Phase 3** — kick off `git fetch` + `merge` in the **background** right after Phase 1, fetch + filter comments meanwhile, **join before Phase 4** (it reads the merged tree). If the background merge reports conflicts, handle them via Phase 2's conflict step first.
- **Phase 3 pages (REST fallback only)** — with predictable offsets (e.g. Bitbucket `start=0,100,200,…`), fetch several pages in parallel and stop when one signals the last (`isLastPage`). CLIs paginate for you.
- **Phase 4 analysis** — per-comment scoring is independent. **Default to targeted `Read`s in the main agent** — subagents re-boot context and raise *total* token cost. Fan out to subagents only on **large** PRs/MRs where main-context size is the real constraint. A comment needing *interactive* design-tool setup must stay in the main agent.
- **Validation build (Phase 5/6)** — run the slow `VALIDATION_CMD` in the **background** and report when done.

**Never background:** approval / multiple-choice prompts, and file edits during implementation. Note long background tasks in the checklist (e.g. `Phase 2 — merge (running in background)`).

---

## Phase 0 — Auto-detect project context

Run before the main workflow; auto-detect everything **silently**. Three rules: **(1) one prompt, not many** — batch every item that genuinely needs the user across 0A–0E into a single multiple-choice prompt; **(2) defer what isn't blocking** — only access (0B) blocks; an undetected validation command (0D) is asked later when first needed; **(3) summarize, don't interrogate** — print a one-line **Detected context** summary (forge · access · conventions file · validation cmd · commit-suggest) and just proceed unless something is genuinely ambiguous.

### 0A — Detect the forge & repo coordinates

```bash
git remote get-url origin
```

| Host | `FORGE` | Term |
|---|---|---|
| `github.com` or GitHub Enterprise | `github` | **PR** |
| `gitlab.com` or self-managed GitLab | `gitlab` | **MR** |
| a Bitbucket host (`bitbucket.org` or a `/scm/…` install) | `bitbucket` | **PR** |
| anything else | ask the user | — |

Use the **term** in all user-facing text. Extract repo coordinates from the remote — `owner`/`repo` (GitHub/GitLab), `project`/`repo` (Bitbucket Server). Handle SSH and HTTPS forms, **strip trailing `.git`**, **drop `user@`** userinfo.

**Bitbucket — confirm with the user.** This skill targets **Bitbucket Server / Data Center**; ask the user to confirm it's Server and confirm the REST base URL (offer the derived default). **Bitbucket Cloud uses a different API and is not supported** — tell the user and stop, unless they supply a Server-compatible base URL. Derived default (account for a context path, e.g. `…/bitbucket/scm/…` → `…/bitbucket/rest/…`, and personal repos `~username` — keep the tilde):
```
BASE_URL = https://{HOST}{CONTEXT_PATH}/rest/api/1.0/projects/{PROJECT}/repos/{REPO}
```

### 0B — Resolve access (CLI-first, REST fallback)

**Step 1 — CLI.** Prefer the official CLI (auth, pagination, JSON handled):
```bash
command -v gh   && gh   auth status   # github
command -v glab && glab auth status   # gitlab
command -v bb                          # bitbucket (server)
```
If present and authenticated: `ACCESS=cli`, skip token/BASE_URL handling entirely, go to 0C.

**Step 2 — REST token (fallback).** Use a single placeholder **`AUTH_REF`** injected into the auth header (header form per forge — see Forge adapters) — either an env var (`$<NAME>`) or a file read (`$(cat "$TOKEN_FILE")`). Test common env vars **without printing the value** (never `echo` a token — it leaks into the transcript/history):
```bash
for v in GH_TOKEN GITHUB_TOKEN GITLAB_TOKEN GL_TOKEN BITBUCKET_TOKEN BITBUCKET_ACCESS_TOKEN BB_TOKEN STASH_TOKEN; do
  [ -n "${!v}" ] && { echo "$v is set"; break; }
done
```
If one is set, remember its **name**, treat `AUTH_REF` as `$<thatname>`, go to 0C.

**Step 3 — Ask the user.** If none found, ask a multiple-choice prompt (header `Forge auth`, question *"No forge token env var found — how do you want to authenticate?"*), batching any other pending Phase-0 questions into the same prompt:

- **"It's under another name"** — ask for the exact name, verify without printing:
  ```bash
  NAME=MY_PAT
  [ -n "${!NAME}" ] && echo "$NAME is set" || echo "$NAME is empty"
  ```
  On success, `AUTH_REF` = `${!NAME}`.

- **"Enter the token now"** — the user pastes it; store it both ways:
  1. **This session** — restricted-permission file, referenced in every later call so the literal token never appears in a subsequent API command (it unavoidably appears once in this write and in the pasted message):
     ```bash
     TOKEN_FILE="${SCRATCHPAD:-${TMPDIR:-/tmp}}/.forge_token"
     ( umask 077; printf '%s' '<pasted-token>' > "$TOKEN_FILE" )
     ```
     `AUTH_REF` = `$(cat "$TOKEN_FILE")`.
  2. **Future sessions** — append an `export` to the shell profile using the forge's canonical name (`GH_TOKEN` / `GITLAB_TOKEN` / `BITBUCKET_TOKEN`), reading the value back from the file, de-duped:
     ```bash
     PROFILE="$HOME/.zshrc"; VAR=BITBUCKET_TOKEN   # forge's canonical name
     grep -q "^export $VAR=" "$PROFILE" 2>/dev/null \
       || printf 'export %s=%s\n' "$VAR" "$(cat "$TOKEN_FILE")" >> "$PROFILE"
     ```
  Warn **once**: pasting puts the token in the transcript; the profile line only affects **new** shells.

- **"Skip"** — fall through to Step 4.

**Step 4 — Manual fallback (no access).** Phases 1 and 3 cannot fetch. Ask the user to paste: title, description, source & target branches, **and the unresolved comment threads** (text, author, file/line for inline ones). Code-validation (Phase 4) still works against the local checkout; resolved state can't be detected — work only from what's pasted.

### 0C — Find the project conventions file

```bash
for f in AGENTS.md CLAUDE.md .claude/CLAUDE.md .github/copilot-instructions.md \
         .cursor/rules .cursorrules .windsurfrules CONTRIBUTING.md docs/ARCHITECTURE.md; do
  [ -f "$f" ] && echo "$f" && break
done
```
Store the first match as `CONVENTIONS_FILE`; if none, `CONVENTIONS_FILE=none` (evaluations fall back to general best practices).

### 0D — Detect the build/validation command

```bash
[ -f "build.gradle" ] || [ -f "build.gradle.kts" ]   # → Gradle
[ -f "package.json" ]                                  # → Node (npm/yarn/pnpm)
[ -f "Makefile" ]                                      # → Make
[ -f "Podfile" ]                                       # → Xcode/CocoaPods
[ -f "pubspec.yaml" ]                                  # → Flutter/Dart
[ -f "Cargo.toml" ]                                    # → Rust
```

For Gradle, grep build files for lint/format plugins — **don't** run `./gradlew tasks --all` (full configuration, can take a minute+):
```bash
grep -rEl "spotless|detekt|ktlint" --include="*.gradle" --include="*.gradle.kts" . 2>/dev/null
```

Compose `VALIDATION_CMD` running formatting + static analysis, e.g. `./gradlew spotlessApply detekt` · `npm run lint && npm run build` · `make lint`. If `CONVENTIONS_FILE` prescribes a validation command, use it verbatim; otherwise default to **without** Gradle `clean` for speed, adding it only for broad changes that risk stale artifacts. If the build system is unclear, **don't ask now** — defer to when `VALIDATION_CMD` is first needed (start of Phase 5).

### 0E — Check for a commit-message helper

```bash
ls .claude/skills/commit-suggest/SKILL.md \
   "$HOME/.claude/skills/commit-suggest/SKILL.md" 2>/dev/null && echo "found"
```
`HAS_COMMIT_SUGGEST=true` if either exists (on other harnesses, substitute their commit-message helper). Used in Phase 6.

---

## Forge adapters

Prefer the **CLI** (`ACCESS=cli`). Without one, call the same endpoints with `curl` against the REST base + auth header, then filter with `jq` so only needed fields enter context:

| Forge | REST base | Auth header |
|---|---|---|
| github | `https://api.github.com` (Enterprise `https://{host}/api/v3`; GraphQL `…/graphql`) | `Authorization: Bearer ${AUTH_REF}` + `Accept: application/vnd.github+json` |
| gitlab | `https://gitlab.com/api/v4` (self-managed `https://{host}/api/v4`) | `PRIVATE-TOKEN: ${AUTH_REF}` |
| bitbucket | `${BASE_URL}` (from 0A) | `Authorization: Bearer ${AUTH_REF}` |

**Always pass the explicit number from Phase 1** — never a bare `gh pr view` / `glab mr view` defaulting to the current branch.

### GitHub — `gh` (term: PR)
- **Meta:** `gh pr view <n> --json title,body,headRefName,baseRefName,reviewRequests,url` · REST `GET /repos/{owner}/{repo}/pulls/{n}`
- **Unresolved inline threads:** GraphQL `reviewThreads`, filtered to `isResolved==false`:
  ```bash
  gh api graphql -f query='{repository(owner:"{owner}",name:"{repo}"){pullRequest(number:{n}){
    reviewThreads(first:100){nodes{isResolved path line
      comments(first:50){nodes{author{login} body}}}}}}}' \
    | jq '[.data.repository.pullRequest.reviewThreads.nodes[] | select(.isResolved==false)]'
  ```
- **General (non-inline) comments:** `gh api repos/{owner}/{repo}/issues/{n}/comments`
- **Tasks:** none — the unit is the unresolved thread (reviewer suggestions appear as ```suggestion fences).

### GitLab — `glab` (term: MR)
- **Meta:** `glab mr view <iid> -F json` · REST `GET /projects/:id/merge_requests/:iid`
- **Unresolved threads:** `glab api projects/:id/merge_requests/:iid/discussions` — keep notes where `resolvable==true && resolved==false`; anchor = `position.new_path` / `position.new_line`; `notes[]` is the thread.
- **Tasks:** map to unresolved discussions.

### Bitbucket — `bb` / REST (term: PR)
- **Meta:** `GET {BASE_URL}/pull-requests/{id}` → `fromRef.displayId` (source), `toRef.displayId` (target), `reviewers[].user.name`.
- **Unresolved threads + tasks:** `GET {BASE_URL}/pull-requests/{id}/activities` (paginate `start` / `isLastPage`); keep `action=="COMMENTED"` with `state=="OPEN"`; recurse `comment.comments[]`; **tasks** are comments with `severity=="BLOCKER"` (state `OPEN`/`RESOLVED`); anchor = `commentAnchor.path` / `commentAnchor.line`. (See the `jq` filter in Phase 3.)

---

## Phase 1 — Fetch change-request details

1. **Ask the user for the `<PR|MR>` number and wait — this is the mandatory entry point.** Never infer it from the current branch or a CLI default: the number drives which branch Phase 2 checks out, so even if the current branch has an open PR/MR, still ask.

2. Fetch metadata via the **Forge adapter** — one CLI command when `ACCESS=cli`, else the REST endpoint piped through `jq` so only needed fields enter context.

3. Extract:
   - **Title** — parse a ticket id: `[A-Z]+-[0-9]+` (Jira) **or** `#NNN` (issue ref); if none, omit the prefix in commit messages.
   - **Source branch** / **Target branch**.
   - **Description** — extra context.
   - **Reviewers** — store as `REVIEWERS`.

---

## Phase 2 — Branch setup

4. `git rev-parse --abbrev-ref HEAD`

5. If not on the source branch, check it out automatically (no confirmation), telling the user inline: *"Switching to `<source-branch>`…"* → `git checkout <source-branch>`

6. Fetch and merge the target — never skip this; stale branches cause hidden conflicts later:
   ```bash
   git fetch origin
   git merge origin/<target-branch>
   ```
   A clean merge auto-creates a **merge commit** — expected, and distinct from the "never commit without instruction" rule (which covers the feature/fix commit after addressing comments). Do not push. May run in the **background** alongside Phase 3; join before Phase 4 (see *Concurrency*).

7. On conflicts:
   - Show conflicted files: `git diff --name-only --diff-filter=U`
   - Ask: **"There are merge conflicts in the following files. Should I attempt to resolve them, or would you prefer to resolve them yourself?"**
   - If resolving: fix each guided by `CONVENTIONS_FILE`, then `git add <files> && git merge --continue`.
   - If the user resolves manually, pause until they say done.

---

## Phase 3 — Fetch unresolved review comments

8. Via the **Forge adapter**, fetch all **unresolved** threads/comments (CLI preferred; REST follows the forge's pagination):
   - **github** — `reviewThreads.isResolved == false` (inline) + general issue comments
   - **gitlab** — notes where `resolvable && !resolved`
   - **bitbucket** — `action=="COMMENTED"` with `state=="OPEN"` (+ tasks `severity=="BLOCKER"`)

   **Token-saving:** filter every API response before it enters context — CLI `--json`/`--jq`, or `curl | jq`. Bitbucket example (loop pages until `isLastPage`):
   ```bash
   curl -s -H "Authorization: Bearer ${AUTH_REF}" "{BASE_URL}/pull-requests/{id}/activities?limit=100&start={start}" \
     | jq -c '[.values[] | select(.action=="COMMENTED") | .comment
              | {id, author: .author.name, state, severity, text,
                 anchor: (.commentAnchor // {} | {path, line}),
                 replies: [.comments[]? | {author: .author.name, state, text}]}]'
   ```

9. For each kept thread, **walk the full tree** and capture:
   - **author** + **body** of the original comment and **each reply** — the actionable request is often in a *reply*.
   - **anchor** — `path` + `line` for **inline** comments; **general** comments have none.
   - **thread context** — reply count and **tasks** with open/resolved state (Bitbucket `severity:"BLOCKER"`; GitHub/GitLab map to the unresolved thread itself).
   - Skip bot/system comments.

**Early exit:** if nothing is unresolved: first ensure any backgrounded Phase 2 merge finished cleanly (not mid-conflict) — resolve or report — then report *"No unresolved comments found on <PR|MR> #{id} — nothing to address."* and end.

---

## Phase 4 — Score, present, and batch-approve

### Step 10 — Score all comments upfront

Score every unresolved comment **1–5**:

| Score | Meaning |
|-------|---------|
| 5 | Critical — architectural violation, correctness bug, or security issue |
| 4 | High — significant code quality or maintainability problem |
| 3 | Medium — style/naming issue or clearly valid improvement |
| 2 | Low — subjective preference or minor nit |
| 1 | Invalid — misunderstanding, outdated context, or factually incorrect |

**Validate against the actual code (required — never score on comment text alone).** For **every** comment, open the code it refers to and judge against what it *actually does*:
- **Inline:** `Read` the file at the anchor `path` around `line` (offset/limit, ±~10 lines) — never whole files.
- **General:** locate the referenced code/area.

Decide: does the issue genuinely exist, or is it already handled / outdated / a misread? If the code contradicts the comment, score **1** and capture why. Cite concrete code in the Evaluation; keep the snippet — Step 11 reuses it.

**Design comments — only when relevant.** If a comment concerns visual/design correctness (spacing, padding, margins, color, typography, sizing, alignment, layout, or names the design/a screen/a mockup), validate the implementation against the design — for these comments only:
1. Check for a **design-tool integration** (Claude Code: Figma MCP, tools under `mcp__…Figma…`).
2. If unavailable, tell the user it's needed for this comment and ask them to connect it (`claude mcp add`), then continue.
3. If available but the exact screen can't be resolved, ask for the screen/node URL — only when you genuinely can't find it.
4. Compare implemented UI against the design **and** the comment's suggestion; fold into the score and Evaluation (e.g. *"design shows 16dp padding; code uses 8dp — comment is valid"*).

Consult `CONVENTIONS_FILE` if available — **`grep` it for keywords relevant to the comment and read only matched sections; never read it whole** (often 1000+ lines). It's the source of truth for violation vs. preference: a comment contradicting a rule scores 1; one enforcing a rule scores 4–5.

Sort by score descending and number **locally 1…N in that order**; reference comments only as `Comment #N` — **never the forge's internal ID**. This step is **internal analysis, no user-facing output** — details print batch by batch in Step 11. Per-comment `Read`s can run in parallel; keep them in the main agent except on large PRs/MRs (see *Concurrency*), and keep any comment needing interactive design-tool setup in the main agent.

### Step 11 — Present each batch's comments (as messages)

Work through the sorted comments in **batches of up to 4** (highest score first). Per batch: print every comment's full detail block as a normal message, then ask for decisions on that batch (Step 12), then continue. Printing details as messages — **not** inside the picker — guarantees nothing is truncated.

```
─────────────────────────────────────────────
Comment #<N> of <total>  [Score: <X>/5]  ·  <author>
File: <path> (line <line>)        ← omit if comment has no anchor
Thread: <e.g. "2 replies · 1 open task">   ← omit if no sub-comments and no tasks

<author>: "<original comment>"
  ↳ <reply-author>: "<reply>"      ← one line per reply, in order; omit if no replies

Code (<path>:<line>):
> <diff-style snippet — anchored line marked, ±5 lines of context>   ← omit if no code location

Evaluation: <2–3 sentences: what the real code does and whether the comment holds. If the thread has replies, name who said what and conclude which position is correct and why — grounded in the code / CONVENTIONS_FILE / the design, not seniority.>

Suggested reply: <short, courteous, Markdown + plain simple human English — acknowledge if valid, or explain why if already handled / outdated / wrong>
```

Every block is complete — full thread, snippet (diff-preview style, reusing the Step 10 lines), and mandatory **Evaluation** + **Suggested reply**, never omitted. For score **1 (Invalid)**, add a `Validity issue: <specific reason>` line directly above the Suggested reply.

### Step 12 — Decide on the batch (AskUserQuestion)

Right after printing a batch, collect decisions for those comments with a multiple-choice prompt — one question per comment, up to **4 per call**. Details are already on screen, so keep it short:

- **`question`**: `"Comment #N [Score X/5] — <one-line summary>. Apply, skip, or modify?"`
- **`header`**: a topic slug **≤12 characters** (e.g. `modifier`) — no score here.
- **`options`** (exactly two — an "Other" free-text choice is auto-appended):
  - `{ label: "Apply", description: "Implement as-is" }`
  - `{ label: "Skip", description: "Ignore this comment" }`
- Apply **with modification** = user picks **"Other"** and types the instruction inline.

Continue in batches until every comment is decided. Track `approved` (Apply + any Other with its instruction) and `skipped`.

**Suggested replies are demonstration-only.** They appear only inline in Step 11 blocks so the user can read/copy them. Never collect, recap, or "prepare for posting" the replies, and **never post anything to the forge** — this skill never posts review replies.

---

## Phase 5 — Implementation plan

13. Summarize the approved list:
```
Approved comments to implement:
1. [Score 5] <brief description>
2. [Score 4] <brief description>
...
```

14. Produce a detailed implementation plan and get approval **before editing** (Claude Code: `EnterPlanMode`):
   - Order tasks by score (highest first); group changes touching the same file.
   - Per approved comment: exact file(s), nature of the change, and which `CONVENTIONS_FILE` rule it satisfies (if applicable).
   - Final validation step using `VALIDATION_CMD` (ask for it now if deferred in 0D). Run it in the background (see *Concurrency*).

15. Present the plan and wait for approval before any edits (Claude Code: `ExitPlanMode`).

> **Plan approval is the last gate.** Once approved, implement all approved changes and **flow straight through Phase 6 and Phase 7 automatically — do not stop to ask whether to continue/resume/proceed.** The only interactive gates left are the Step 18 rules confirmation and the standing *never commit without explicit instruction* rule.

---

## Phase 6 — Post-implementation

16. Suggest a commit message:
   - `HAS_COMMIT_SUGGEST=true` → invoke the `commit-suggest` skill.
   - Otherwise compose one following project conventions (commit guidance in `CONVENTIONS_FILE` or `how_to_write_commit_messages.md` at the repo root).

---

## Phase 7 — Extract rules & learn

Turn what was processed into durable rules so the same review comments don't recur. Runs **after** the commit-suggest step.

### Step 17 — Derive candidate rules

From the **applied** comments (and reasoning) plus the **invalid** ones and their replies, extract concise, checkable rules — the underlying principle, not the one-off fix (e.g. *"Composables must accept `modifier: Modifier = Modifier` as the first optional parameter"*); cite external/team sources. Skip anything already documented. Also: if a `REVIEWERS` member left multiple high-score comments consistently enforcing a pattern absent from `CONVENTIONS_FILE`, flag it as a candidate rule.

### Step 18 — Confirm with the user

Present the candidates and let the user confirm or trim **before writing anything**. Never write unapproved rules.

### Step 19 — Write to the standalone rules file

Maintain a single cumulative **`docs/pr-review-rules.md`** (create `docs/` and the file if missing). Append approved rules under a dated / PR-tagged heading and **de-dupe** against existing ones.

### Step 20 — Point to it from the conventions file

Ensure the agent-instructions file (`CONVENTIONS_FILE`; priority **`AGENTS.md`** → **`CLAUDE.md`** → `.github/copilot-instructions.md` → `.cursor` rules) references the rules file with a single pointer line, e.g. *"Always review and follow `docs/pr-review-rules.md` — accumulated rules extracted from PR review comments."* **Idempotent:** if such a line exists, leave it.

### Step 21 — Reconcile an existing extraction convention

If the conventions file already prescribes its own rules-extraction method, route **new** rules into `docs/pr-review-rules.md` and point to it from that section rather than duplicating inline. On first use, offer a one-time **kickstart**: with the user's confirmation, move review-derived rules already embedded in the conventions file into `docs/pr-review-rules.md` and replace them with the pointer. **Never bulk-edit a large conventions file without showing the user exactly what moves first.**

### Step 22 — Honor any file-sync mandate

If editing the conventions file triggers a "sync to other repos" rule (e.g. AGENTS.md §0.2): copy the updated file when target paths are **real, resolvable directories**; if they're placeholders (e.g. `<path-to-rewrite-repo-1>`) or missing, **skip** and print a one-line reminder to sync manually.
