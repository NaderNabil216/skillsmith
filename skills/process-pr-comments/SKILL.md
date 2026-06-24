---
name: process-pr-comments
description: Full PR/MR review-comment workflow for GitHub, GitLab, and Bitbucket. Use whenever the user wants to process, address, or work through pull- or merge-request review comments — e.g. "process PR comments", "address review feedback on PR/MR 123", "apply PR review comments", "work through MR X". Detects the forge, prefers the official CLI (gh/glab/bb) with REST fallback, then handles branch checkout, fetching updates, scoring unresolved comments validated against the actual code (and against the design tool for design comments), showing each comment with a code snippet, getting user approval per comment, generating an implementation plan, suggesting a commit message, and extracting reusable rules into a standalone rules file. Capability-based steps with a Claude Code tool-mapping section.
---

# Process PR / MR Review Comments

End-to-end workflow for addressing unresolved review comments on a **GitHub PR, GitLab MR, or Bitbucket PR**. The flow is forge-agnostic: a per-forge **Forge adapter** supplies the few commands that differ.

---

## Requirements & tool mapping

**Runtime:** needs `git` and a POSIX shell. Prefers the forge's official CLI (`gh` / `glab` / `bb`); otherwise `curl` + `jq` (if `jq` is missing, use the CLI's `--json`/`--jq`, or extract the minimum by hand).

**Capabilities → Claude Code.** The steps below are written as capabilities; bind them to your harness. In Claude Code:

| Capability | Claude Code binding |
|---|---|
| ask the user a multiple-choice question | `AskUserQuestion` (≤4 questions/call) |
| present a plan and get approval before editing | `EnterPlanMode` → `ExitPlanMode` |
| read a file (bounded) · search files · run a shell command (optionally backgrounded) | `Read` (offset/limit) · `Grep` · `Bash` (`run_in_background`) |
| run independent work in parallel | subagent (Agent tool) |
| optional live task list | `TaskCreate` / `TaskUpdate` |
| design-tool lookup | Figma MCP (`mcp__…Figma…`) or any design integration |
| commit-message helper | the `commit-suggest` skill, found by name (see 0E) |

On other harnesses, substitute equivalents. If a capability is missing (e.g. no multiple-choice UI), fall back to a plain numbered question and wait for the answer.

---

## Progress checklist (show throughout)

Keep the user oriented with a nested checklist (phases + their sub-phases). **Print it once at the very start** (all items pending, Phase 0 in progress), and **re-print the full tree only at the start of each phase** — reprinting on every sub-phase is noisy and token-heavy; within a phase a compact one-liner like `Phase 3/7 ▸ filtering comments` is enough. Mark finished items `[✓]`, the current one with a trailing `← in progress`, and the rest `[ ]`. A parent phase is `[✓]` only once all its sub-phases are done.

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

Guidance:
- Omit `<id>` until Phase 1 resolves it, then fill it in.
- Check off **sub-phases** as you finish them; a phase with no sub-phases (1, 6) is a single line.
- Keep it to **phases and sub-phases** — don't expand every numbered Step (1–22) into the list.
- If the workflow exits early (e.g. Phase 3 finds no unresolved comments), print the checklist with items reached marked `[✓]` and the remainder struck through as `~~…~~ (skipped)`.
- If the harness exposes a task list (`TaskCreate`/`TaskUpdate`), you may mirror these items there too — but the printed checklist is what the user reads.

---

## Concurrency & background (speed)

Several phases are I/O-heavy. Overlap work that has no data dependency; keep anything interactive sequential. Mechanisms: issue independent tool calls **in one message** (they run concurrently), use **background Bash** (`run_in_background`) for slow commands, and **fan out subagents** for per-comment work.

**Parallelize / background:**
- **Phase 0 detections** — 0A, 0C, 0D, 0E are independent local checks; run them as parallel Bash calls in one message.
- **Phase 2 ∥ Phase 3** — branch setup doesn't depend on fetching comments. Kick off `git fetch` + `merge` in the **background** right after Phase 1, fetch + filter comments (Phase 3) meanwhile, and **join before Phase 4** (it reads the merged working tree). If the background merge reports conflicts, handle them via Phase 2's conflict step before continuing.
- **Phase 3 pages (REST fallback only)** — the CLIs paginate for you; when paging REST yourself and the forge uses predictable offsets (e.g. Bitbucket `start=0,100,200,…`), fetch several pages in parallel and stop once a page signals the last one (`isLastPage`), instead of strictly one at a time.
- **Phase 4 analysis** — per-comment scoring/validation (read anchor code, optional design-tool check, score, snippet, draft reply) is independent per comment. **For fewer tokens, default to targeted `Read`s in the main agent** — subagents re-boot context and raise *total* token cost. Only **fan out to subagents on large PRs/MRs** (many comments) where main-context size is the real constraint. Either way, a comment needing *interactive* design-tool setup (connect the integration / paste a screen URL) must stay in the main agent.
- **Validation build (Phase 5/6)** — run the slow `VALIDATION_CMD` in the **background** and report when it finishes.

**Keep sequential (never background):** any approval / multiple-choice prompt (the Phase 0 consolidated prompt, Phase 4 decisions, Phase 5 plan approval) and file edits during implementation (concurrent edits to the same file conflict).

When a long task runs in the background, note it in the progress checklist (e.g. `Phase 2 — merge (running in background)`).

---

## Phase 0 — Auto-detect project context

Run these steps **before the main workflow begins** — they establish the project-specific values the rest of the skill depends on. Auto-detect everything you can **silently**; three rules keep Phase 0 from turning into a gauntlet of prompts:

1. **One prompt, not many.** Don't fire a separate question per sub-step. Gather every item across 0A–0E that genuinely needs the user (couldn't be auto-detected) and ask them **together in a single multiple-choice prompt** (Claude Code `AskUserQuestion`, up to 4 questions/call).
2. **Defer what isn't blocking.** Only access (0B) blocks the next phase. If the validation command (0D) can't be detected, **don't ask now** — resolve it later, when it's first needed.
3. **Summarize, don't interrogate.** After detection, print a one-line **Detected context** summary (forge · access method · conventions file · validation cmd · commit-suggest). If everything resolved cleanly, just proceed — ask for confirmation only when something is genuinely ambiguous.

### 0A — Detect the forge & repo coordinates

```bash
git remote get-url origin
```

Identify `FORGE` from the host, and store the change-request **term** (used in all user-facing text):

| Host | `FORGE` | Term |
|---|---|---|
| `github.com` or GitHub Enterprise | `github` | **PR** |
| `gitlab.com` or self-managed GitLab | `gitlab` | **MR** |
| a Bitbucket host (`bitbucket.org` or a `/scm/…` install) | `bitbucket` | **PR** |
| anything else | ask the user which forge | — |

Extract the repo coordinates from the remote — `owner`/`repo` for GitHub/GitLab, `project`/`repo` for Bitbucket Server. Handle SSH (`git@host:owner/repo.git`) and HTTPS, **strip the trailing `.git`**, and **drop any `user@`** userinfo.

**Bitbucket — confirm with the user.** This skill targets **Bitbucket Server / Data Center**. For any Bitbucket host, **ask the user to confirm it's Server** and to confirm the REST base URL (offer the derived value as the default). **Bitbucket Cloud (`bitbucket.org`) uses a different API and is not yet supported** — if it's Cloud, tell the user and stop, unless they can supply a Server-compatible base URL. Derived default:
```
BASE_URL = https://{HOST}{CONTEXT_PATH}/rest/api/1.0/projects/{PROJECT}/repos/{REPO}
```
accounting for a **context path** (e.g. `…/bitbucket/scm/…` → `…/bitbucket/rest/…`) and **personal repos** (`~username` project segment — keep the tilde).

### 0B — Resolve access (CLI-first, REST fallback)

Prefer the forge's official **CLI** — it handles auth, pagination, and JSON, and is the most portable path. The per-forge command lives in the **Forge adapters** section.

**Step 1 — CLI.** Check the CLI exists and is authenticated:
```bash
command -v gh   && gh   auth status   # github
command -v glab && glab auth status   # gitlab
command -v bb                          # bitbucket (server)
```
If present and authenticated, set `ACCESS=cli` and use it for Phases 1 & 3 — **skip the token/BASE_URL handling entirely**, then go to 0C.

**Step 2 — REST token (fallback).** If there's no usable CLI, authenticate REST calls. Use a single placeholder, **`AUTH_REF`**, injected into the header — either an env var (`$<NAME>`) or a file read (`$(cat "$TOKEN_FILE")`):
```bash
curl -s -H "Authorization: Bearer ${AUTH_REF}" "{URL}"   # header form differs per forge — see Forge adapters (GitLab uses PRIVATE-TOKEN)
```
Test common env vars for the forge **without printing the value** (never `echo` a token — it leaks into the transcript/shell history):
```bash
# github: GH_TOKEN GITHUB_TOKEN · gitlab: GITLAB_TOKEN GL_TOKEN · bitbucket: BITBUCKET_TOKEN BITBUCKET_ACCESS_TOKEN BB_TOKEN STASH_TOKEN
for v in GH_TOKEN GITHUB_TOKEN GITLAB_TOKEN GL_TOKEN BITBUCKET_TOKEN BITBUCKET_ACCESS_TOKEN BB_TOKEN STASH_TOKEN; do
  [ -n "${!v}" ] && { echo "$v is set"; break; }
done
```
If one is set, remember its **name** and treat `AUTH_REF` as `$<thatname>`. Done — skip to 0C.

**Step 3 — Ask the user.** If no env var was found, do **not** silently move on. Ask a multiple-choice prompt (header `Forge auth`, question *"No forge token env var found — how do you want to authenticate?"*). If other Phase-0 items also need input (e.g. an unknown forge in 0A), batch them into the **same** prompt:

- **"It's under another name"** — the token is in the environment under a name not checked above. Ask for the exact name, then verify without printing the value:
  ```bash
  NAME=MY_PAT          # the exact name the user gave
  [ -n "${!NAME}" ] && echo "$NAME is set" || echo "$NAME is empty"
  ```
  On success, treat `AUTH_REF` as `${!NAME}`.

- **"Enter the token now"** — the user pastes it; store it **both** ways:
  1. **This session** — write it to a restricted-permission file and reference that file in every later call, so the literal token never appears in a *subsequent* API command (it unavoidably appears once in the write command below, and in the user's pasted message — inherent to any pasted secret):
     ```bash
     TOKEN_FILE="${SCRATCHPAD:-${TMPDIR:-/tmp}}/.forge_token"   # use your session scratchpad dir if you have one
     ( umask 077; printf '%s' '<pasted-token>' > "$TOKEN_FILE" )   # umask 077 => chmod 600
     ```
     Treat `AUTH_REF` as `$(cat "$TOKEN_FILE")`.
  2. **Future sessions** — append an `export` to the user's shell profile (`~/.zshrc` for zsh, `~/.bashrc` for bash) using the forge's canonical env name (`GH_TOKEN` / `GITLAB_TOKEN` / `BITBUCKET_TOKEN`). Read the value back from the file (so the literal token isn't retyped) and de-dupe:
     ```bash
     PROFILE="$HOME/.zshrc"; VAR=BITBUCKET_TOKEN   # set VAR to the forge's canonical name
     grep -q "^export $VAR=" "$PROFILE" 2>/dev/null \
       || printf 'export %s=%s\n' "$VAR" "$(cat "$TOKEN_FILE")" >> "$PROFILE"
     ```
  Warn the user **once**: pasting the token into chat puts it in the transcript, and the profile line only takes effect in **new** shells.

- **"Skip"** — fall through to Step 4.

**Step 4 — Manual fallback (no access).** If neither a CLI nor a token is available, the forge API is unreachable — Phases 1 **and 3** cannot fetch. Ask the user to paste directly: the change-request title, description, source & target branches, **and the unresolved comment threads** (each comment's text, author, and file/line for inline ones). Code-validation (Phase 4) still works against the local checkout, but you cannot detect resolved state — work only from what the user pastes. (The skill never posts replies in any mode; suggested replies are demonstration-only — see Step 12.)

### 0C — Find the project conventions file

Check for a conventions/architecture file in this order:
```bash
for f in AGENTS.md CLAUDE.md .claude/CLAUDE.md .github/copilot-instructions.md \
         .cursor/rules .cursorrules .windsurfrules CONTRIBUTING.md docs/ARCHITECTURE.md; do
  [ -f "$f" ] && echo "$f" && break
done
```

Store the first match as `CONVENTIONS_FILE`. If none is found, set `CONVENTIONS_FILE=none` and note that no conventions file was detected — evaluations will rely on general best practices instead.

### 0D — Detect the build/validation command

Check for these indicators in order:
```bash
[ -f "build.gradle" ] || [ -f "build.gradle.kts" ]   # → Gradle
[ -f "package.json" ]                                  # → Node (npm/yarn/pnpm)
[ -f "Makefile" ]                                      # → Make
[ -f "Podfile" ]                                       # → Xcode/CocoaPods
[ -f "pubspec.yaml" ]                                  # → Flutter/Dart
[ -f "Cargo.toml" ]                                    # → Rust
```

For Gradle, detect lint/format plugins by grepping the build files — **do not** run `./gradlew tasks --all`, which triggers a full configuration and can take a minute or more:
```bash
grep -rEl "spotless|detekt|ktlint" --include="*.gradle" --include="*.gradle.kts" . 2>/dev/null
```

Compose a `VALIDATION_CMD` that runs formatting + static analysis. Examples:
- Gradle + spotless + detekt: `./gradlew spotlessApply detekt`
- npm: `npm run lint && npm run build`
- Make: `make lint`

> **`clean` trade-off (Gradle):** prepending `clean` (`./gradlew clean spotlessApply detekt`) guarantees a fresh build and catches stale-output issues, but is noticeably slower. If `CONVENTIONS_FILE` prescribes a validation command, use that verbatim; otherwise default to **without** `clean` for speed and add it only when a change is broad enough to risk stale artifacts.

If the build system is unclear, **don't ask now** — Phase 0 shouldn't block on it. Defer the question *"What command should I run to validate the build after changes?"* to the start of Phase 5 (or the first time `VALIDATION_CMD` is actually needed).

### 0E — Check for a commit-message helper

Search for a `commit-suggest` skill **by name** in both the project-local and global skill dirs:
```bash
ls .claude/skills/commit-suggest/SKILL.md \
   "$HOME/.claude/skills/commit-suggest/SKILL.md" 2>/dev/null && echo "found"
```
Store as `HAS_COMMIT_SUGGEST=true/false` (true if either exists). On other harnesses, substitute any commit-message helper they expose. Used in Phase 6.

---

## Forge adapters

Per-forge specifics. Prefer the **CLI** path (`ACCESS=cli`). The `gh api` / `glab api` commands below are CLI conveniences — **without a CLI** (token-only REST), call the same endpoints with `curl` against the forge's REST base + auth header, then `jq`:

| Forge | REST base | Auth header |
|---|---|---|
| github | `https://api.github.com` (Enterprise `https://{host}/api/v3`; GraphQL `…/graphql`) | `Authorization: Bearer ${AUTH_REF}` + `Accept: application/vnd.github+json` |
| gitlab | `https://gitlab.com/api/v4` (self-managed `https://{host}/api/v4`) | `PRIVATE-TOKEN: ${AUTH_REF}` |
| bitbucket | `${BASE_URL}` (derived/confirmed in 0A) | `Authorization: Bearer ${AUTH_REF}` |

Use the change-request **term** (PR vs MR) in all user-facing text. **Always pass the explicit number the user gave in Phase 1** — never a bare `gh pr view` / `glab mr view` that defaults to the current branch's change-request.

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
- **Tasks:** none — the unit is the unresolved thread. (Reviewer suggestions appear as ```suggestion fences in the body.)

### GitLab — `glab` (term: MR)
- **Meta:** `glab mr view <iid> -F json` · REST `GET /projects/:id/merge_requests/:iid`
- **Unresolved threads:** `glab api projects/:id/merge_requests/:iid/discussions` — keep notes where `resolvable==true && resolved==false`; anchor = `position.new_path` / `position.new_line`; `notes[]` is the thread.
- **Tasks:** map to unresolved discussions.

### Bitbucket — `bb` / REST (term: PR)
- **Meta:** `GET {BASE_URL}/pull-requests/{id}` → `fromRef.displayId` (source), `toRef.displayId` (target), `reviewers[].user.name`.
- **Unresolved threads + tasks:** `GET {BASE_URL}/pull-requests/{id}/activities` (paginate `start` / `isLastPage`); keep `action=="COMMENTED"` with `state=="OPEN"`; recurse `comment.comments[]`; **tasks** are comments with `severity=="BLOCKER"` (state `OPEN`/`RESOLVED`); anchor = `commentAnchor.path` / `commentAnchor.line`. (See the `jq` filter in Phase 3.)

---

## Phase 1 — Fetch change-request details

1. **Ask the user for the `<PR|MR>` number and wait for the answer — this is the mandatory entry point of the workflow.** Do **not** infer it from the current branch, from a CLI current-branch default (e.g. `gh pr view` with no number), or from any other auto-detection. The number the user gives is what drives which branch gets checked out in Phase 2 — so **even if the current branch already has an open PR/MR, still ask**, because the user may want a different one. Inferring it inverts the flow and defeats the skill.

2. Fetch its metadata via the **Forge adapter** for `FORGE` — one CLI command when `ACCESS=cli` (e.g. `gh pr view`, `glab mr view`), else the REST endpoint piped through `jq` so only the needed fields enter context.

3. Extract:
   - **Title** — parse a ticket id: `[A-Z]+-[0-9]+` (Jira, e.g. `EPTA-35`) **or** `#NNN` (GitHub/GitLab issue ref). If none, omit the prefix in commit messages.
   - **Source branch** / **Target branch** — the branches it merges from/into.
   - **Description** — for additional context.
   - **Reviewers** — store as `REVIEWERS`.

---

## Phase 2 — Branch setup

4. Check the current branch:
   ```bash
   git rev-parse --abbrev-ref HEAD
   ```

5. If not already on the source branch, check it out automatically — no confirmation needed. Inform the user inline:
   > "Switching to `<source-branch>`…"
   ```bash
   git checkout <source-branch>
   ```

6. Fetch remote updates and merge the target branch:
   ```bash
   git fetch origin
   git merge origin/<target-branch>
   ```
   > A clean merge auto-creates a **merge commit** on the source branch. This is expected and is distinct from the "never commit without instruction" rule, which refers to the *feature/fix commit* you make after addressing comments. Do not push.
   >
   > **Speed:** run this `fetch` + `merge` in the **background** and do Phase 3 (fetch comments) while it runs; **join before Phase 4**. See *Concurrency & background*.

7. If merge exits with conflicts:
   - Show the conflicted files: `git diff --name-only --diff-filter=U`
   - Ask the user: **"There are merge conflicts in the following files. Should I attempt to resolve them, or would you prefer to resolve them yourself?"**
   - On confirmation to resolve, inspect each conflicted file and resolve guided by `CONVENTIONS_FILE`. After resolving, run `git add <files> && git merge --continue`.
   - If the user prefers to resolve manually, pause and wait for them to say they are done.

---

## Phase 3 — Fetch unresolved review comments

8. Using the **Forge adapter** for `FORGE`, fetch all **unresolved** review threads/comments. Prefer the CLI; via REST, follow the forge's pagination. Filter to unresolved by the forge's resolved field:
   - **github** — `reviewThreads.isResolved == false` (inline) + general issue comments
   - **gitlab** — discussion notes where `resolvable && !resolved`
   - **bitbucket** — `action=="COMMENTED"` with `state=="OPEN"` (+ tasks `severity=="BLOCKER"`)

   **Token-saving:** keep only the needed fields in context — use the CLI's `--json`/`--jq`, or pipe `curl` through `jq`. Bitbucket REST example (loop pages until `isLastPage`):
   ```bash
   curl -s -H "Authorization: Bearer ${AUTH_REF}" "{BASE_URL}/pull-requests/{id}/activities?limit=100&start={start}" \
     | jq -c '[.values[] | select(.action=="COMMENTED") | .comment
              | {id, author: .author.name, state, severity, text,
                 anchor: (.commentAnchor // {} | {path, line}),
                 replies: [.comments[]? | {author: .author.name, state, text}]}]'
   ```

9. For each kept thread, **walk the full tree** and capture:
   - **author** + **body** of the original comment and **each reply** — the actionable request is often in a *reply*, not the top comment.
   - **anchor** — `path` + `line` for **inline** comments; **general** comments have none (no `File (line)` header later).
   - **thread context** — reply count and any **tasks** with their open/resolved state (Bitbucket `severity:"BLOCKER"`; GitHub/GitLab map to the unresolved thread itself).
   - Skip bot/system comments.

**Early exit:** if no unresolved comments remain after filtering: first **ensure any backgrounded Phase 2 merge has finished cleanly** (not left mid-conflict) — resolve or report its state — then report *"No unresolved comments found on <PR|MR> #{id} — nothing to address."* and end the workflow.

---

## Phase 4 — Score, present, and batch-approve

### Step 10 — Score all comments upfront

Evaluate every unresolved comment and assign a **score from 1 to 5**:

| Score | Meaning |
|-------|---------|
| 5 | Critical — architectural violation, correctness bug, or security issue |
| 4 | High — significant code quality or maintainability problem |
| 3 | Medium — style/naming issue or clearly valid improvement |
| 2 | Low — subjective preference or minor nit |
| 1 | Invalid — based on a misunderstanding, outdated context, or factually incorrect |

**Validate against the actual code (required).** Scoring on the comment text alone is not enough — for **every** comment, open the real code it refers to and judge the comment against what the code *actually does*:
- **Inline comments:** read the file at the `commentAnchor` `path`, around `line` (±~10 lines for context).
- **General comments:** locate the code/area they reference.

Then decide: does the issue genuinely exist in the current code, or is it already handled / outdated / based on a misread? This evidence drives the score — if the code contradicts the comment, score it **1** and capture why. Always cite the concrete code in the Evaluation. Keep the snippet you read — Step 11 reuses it.

**Design comments — only when relevant.** If a comment is about visual/design correctness (spacing, padding, margins, color, typography, sizing, alignment, layout, or it names the design / a screen / a mockup), validate the implementation against the design — for these comments only, never for all of them:
1. Check whether a **design-tool integration** is available (Claude Code: a Figma MCP — tools under `mcp__…Figma…`).
2. If **not available**, tell the user it's needed for this comment and ask them to connect it (Claude Code: `claude mcp add` for the Figma server), then continue once connected.
3. If **available but the exact screen can't be resolved**, ask the user to paste the design screen/slide URL (or node URL) — only when you genuinely can't find it, not every time.
4. Compare the implemented UI against the design **and** against the comment's suggestion, and fold the result into the score and Evaluation (e.g. *"design shows 16dp padding; code uses 8dp — comment is valid"*).

> If scoring is fanned out to subagents (see *Concurrency & background*), keep any comment that needs MCP connection or a pasted screen URL in the **main agent** — subagents can't run that interaction.

When scoring, also consult `CONVENTIONS_FILE` if available — **`grep` it for the keywords relevant to the comment and read only the matched sections; don't read the whole file** (it's often 1000+ lines). If a comment directly contradicts a rule there, score it 1; if it enforces one, score it 4–5.

Sort comments by score descending, then number them **locally 1…N in that order** (N = total unresolved comments — e.g. 5 comments → `1`…`5`). Reference comments only by this local number (`Comment #N`) everywhere — **never the forge's internal comment ID**, which is meaningless to the user. This whole step is **internal analysis** — produce **no** user-facing output here; the details are printed as full messages, batch by batch, in Step 11. Because each comment's analysis is independent, you can parallelize the `Read`s. For **fewer tokens**, do these in the **main agent** on small/medium PRs/MRs; only fan out to subagents on **large** ones where main-context size is the real constraint — see *Concurrency & background*.

### Step 11 — Present each batch's comments (as messages)

Work through the sorted comments in **batches of up to 4** (highest score first). For **each batch**: print every comment's full detail block as a normal message, then immediately ask for decisions on that batch (Step 12), then move on. Printing the details as messages — **not** inside the picker — guarantees the thread, evaluation, and reply are never truncated.

Print each comment as:

```
─────────────────────────────────────────────
Comment #<N> of <total>  [Score: <X>/5]  ·  <author>
File: <path> (line <line>)        ← omit if comment has no anchor
Thread: <e.g. "2 replies · 1 open task">   ← omit if no sub-comments and no tasks

<author>: "<original comment>"
  ↳ <reply-author>: "<reply>"      ← one line per reply, in order; omit if no replies
  ↳ <reply-author>: "<reply>"

Code (<path>:<line>):
> <diff-style snippet — anchored line marked, ±5 lines of context>   ← omit if no code location

Evaluation: <2–3 sentences: what the real code does and whether the comment holds. If the thread has replies, name who said what (e.g. "Omar wants X; Sayed counters Y") and conclude which position is correct and why — grounded in the code / CONVENTIONS_FILE / the design, not in who is more senior.>

Suggested reply: <short, courteous, Markdown + plain simple human English — acknowledge if valid, or explain why if already handled / outdated / wrong>
```

- **Every block is complete** — `Comment #N` (the local number), the full thread, the snippet, the **Evaluation**, and the **Suggested reply**. Evaluation and Suggested reply are **mandatory** on every comment, never omitted.
- **Show the whole thread:** the original comment with its author, then each reply indented with its author (`↳ author: "…"`), in order — the real request often lives in a reply or task.
- **When the thread has back-and-forth, the Evaluation must adjudicate it** — attribute each position to its author and decide which is correct and why, by the code (not seniority).
- **Thread line:** counts + open-task status (e.g. `3 replies · 2 tasks (1 open)`); omit if none.
- The reply is always **Markdown, plain simple English** (no jargon dumps). For score **1 (Invalid)**, add a `Validity issue: <specific reason>` line directly above the Suggested reply.
- Render the snippet diff-preview style (the file's language, anchored line marked), reusing the lines you read in Step 10; omit it for general comments with no code location.

### Step 12 — Decide on the batch (AskUserQuestion)

Right after printing a batch's detail blocks, collect decisions for **those same comments** with a multiple-choice prompt (Claude Code `AskUserQuestion`) — one question per comment, up to **4 per call** (matching the batch just shown). The details are already on screen, so the question stays short:

- **`question`**: `"Comment #N [Score X/5] — <one-line summary>. Apply, skip, or modify?"` (N is the local number)
- **`header`**: a topic slug **≤12 characters** (e.g. `modifier`, `mapNotNull`). Don't put the score here — it's in the question.
- **`options`** (exactly two — `AskUserQuestion` auto-appends an "Other" free-text choice):
  - `{ label: "Apply", description: "Implement as-is" }`
  - `{ label: "Skip", description: "Ignore this comment" }`
- To apply **with a modification**, the user picks **"Other"** and types the instruction inline — no separate round needed.

Continue in batches until every comment has a decision. Track:
- `approved` — "Apply" decisions, plus any "Other" decision (with its inline custom instruction text)
- `skipped` — "Skip" decisions

The **Suggested reply** is surfaced **only** inline, as part of each comment's demonstration block in Step 11 — that is its sole purpose. Do **not** collect, recap, batch, or otherwise "prepare for posting" the replies for skipped/invalid (or any) comments, and do **not** post anything to the forge — this skill never posts review replies. The reply text is shown purely so the user can read it alongside the comment and copy it themselves if they wish; no further action on replies is taken or offered.

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
   - Order tasks by score (highest first).
   - For each approved comment, specify the exact file(s) to change, the nature of the change, and which rule from `CONVENTIONS_FILE` it satisfies (if applicable).
   - Group changes that touch the same file to avoid back-and-forth edits.
   - Include a final validation step using `VALIDATION_CMD` (if it was deferred in Phase 0 because the build system was unclear, ask for it now).

15. Present the plan and wait for the user's approval before making any edits (Claude Code: `ExitPlanMode`).

> **Plan approval is the last gate before implementation.** Once the plan is approved, implement all approved changes, and **when the edits are done flow straight on into Phase 6 and then Phase 7 on your own — do not stop to ask whether you should continue, "resume", or proceed.** The only interactive gates remaining after Step 15 are confirming the extracted rules (Step 18) and the standing *never commit without explicit instruction* rule; everything else through the end of Phase 7 runs automatically.

---

## Phase 6 — Post-implementation

16. After implementation, suggest a commit message:
   - If `HAS_COMMIT_SUGGEST=true`: invoke the `commit-suggest` skill.
   - Otherwise: compose a commit message following the project's conventions (look for commit message guidance in `CONVENTIONS_FILE` or `how_to_write_commit_messages.md` at the repo root).

---

## Phase 7 — Extract rules & learn

Turn what was just processed into durable, reusable rules so the same review comments don't recur. Runs **after** the commit-suggest step.

### Step 17 — Derive candidate rules

From the comments that were **applied** (and their reasoning) plus the **invalid** comments and their replies, extract concise, actionable rules/patterns — the underlying principle, not the one-off fix. Phrase each as a checkable rule (e.g. *"Composables must accept `modifier: Modifier = Modifier` as the first optional parameter"*) and, where it came from an external/team source, cite it. Skip anything already documented.

### Step 18 — Confirm with the user

Present the candidate rules and ask the user to confirm or trim them **before writing anything**. Do not write rules the user hasn't approved.

### Step 19 — Write to the standalone rules file

Maintain a single cumulative file: **`docs/pr-review-rules.md`** (create `docs/` and the file if missing). Append the approved rules under a dated / PR-tagged heading, and **de-dupe** against rules already in the file. This file is the growing home for review-derived rules plus the comment history behind them.

### Step 20 — Point to it from the conventions file

Ensure the agent-instructions file (the `CONVENTIONS_FILE` from 0C) references the rules file so agents must review it. Priority: **`AGENTS.md`** → **`CLAUDE.md`** → `.github/copilot-instructions.md` → `.cursor` rules.
- Add a single pointer line, e.g. *"Always review and follow `docs/pr-review-rules.md` — accumulated rules extracted from PR review comments."*
- **Idempotent:** if such a pointer line already exists, leave it as is — do not duplicate.

### Step 21 — Reconcile an existing extraction convention

If the conventions file already prescribes its own rules-extraction method (e.g. a section like *"Extracting Rules from PR Review Comments"*), route **new** rules into `docs/pr-review-rules.md` and point to it from that section, rather than duplicating rules inline. On first use, offer a one-time **kickstart**: with the user's confirmation, move the PR-review-derived rules / patterns / standards already embedded in the conventions file into `docs/pr-review-rules.md`, then replace them with the pointer. **Never bulk-edit a large conventions file without showing the user exactly what moves first.**

### Step 22 — Honor any file-sync mandate

If editing the conventions file triggers a "sync to other repos" rule (e.g. AGENTS.md §0.2):
- If the target repo paths are **real, resolvable directories**, copy the updated file there as the rule requires.
- If they're **placeholders** (e.g. `<path-to-rewrite-repo-1>`) or missing, **skip** the copy and print a one-line reminder that the user must sync manually.

---

## Notes

- Re-print the **progress checklist** (see top) at the start of each phase (a one-line status is enough within a phase), so the user always sees where the workflow stands.
- Detect the forge first (0A) and use its **term** (PR vs MR) and its **adapter** throughout — never assume Bitbucket.
- The Phase 1 PR/MR number is **always asked, never inferred** from the current branch — it determines which branch to check out (Phase 2), so auto-detecting it inverts and breaks the whole flow.
- Never commit without explicit user instruction.
- Never skip the merge step — stale branches cause hidden conflicts later.
- Prefer the forge CLI (`gh`/`glab`/`bb`) when authenticated; only fall back to a REST token (env var → ask → paste) when there's no usable CLI.
- Never `echo`/print a token; keep it out of **API** command lines — reference `$(cat "$TOKEN_FILE")` (see 0B for the one-time write + paste caveat).
- Always validate a comment against the **actual code** before scoring — never score on the comment text alone.
- **Bounded reads (token-saving):** read code with `Read` `offset`/`limit` around the anchor (±10 lines); never read whole files; keep snippets ±3–5 lines. Filter every API response with `jq` before it enters context.
- Use the design tool (Figma or equivalent) **only** for design comments, and only prompt for a screen URL when it can't be auto-resolved.
- If `CONVENTIONS_FILE` exists, **don't read it whole** (often 1000+ lines) — `grep` it for the keywords relevant to each comment and read only the matched sections. It's the source of truth for violation vs. preference.
- If a reviewer listed in `REVIEWERS` has left multiple high-score comments that consistently enforce a pattern not yet in `CONVENTIONS_FILE`, note this to the user as a candidate rule to add.
- After the plan is approved and the edits are made, **continue automatically** through Phase 6 (commit message) and Phase 7 (rules) — do not pause to ask whether to resume/proceed. The only remaining gates are the Step 18 rules confirmation and "never commit without instruction".
- **Suggested replies are demonstration-only.** They appear inline in each Step 11 block so the user can read them next to the comment; the skill never recaps, prepares-for-posting, or posts review replies to the forge.
- Phase 7 writes rules only **after** the user confirms them, and never bulk-edits the conventions file without showing the proposed changes first.
