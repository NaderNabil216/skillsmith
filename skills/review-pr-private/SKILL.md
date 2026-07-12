---
name: review-pr-private
description: >
  Universal PR review workflow for any AI assistant to verify architecture, clean code, SOLID
  design, and test quality in any programming language. Two modes: simple (default) reviews the
  diff with severity-ranked findings; advanced adds existing-comment dedup (never repeat what
  reviewers already said — agree/reply/react instead), security/performance/dependency review,
  and optional build+test verification in a temporary worktree. Use when asked to "review PR
  123", "review this MR", "review this branch against develop", "compare and review feature/x",
  or "do a deep/advanced/thorough review of this PR".
---

# Universal PR Review Workflow

Use this workflow to compare a source (PR) branch against a target branch, perform a code review following clean code, SOLID, and testing guidelines, and format the feedback for the author — all without disturbing the user's current checkout.

## Modes

Usage: `review-pr [pr-number|branch] [simple|advanced]`

Default is **simple** when no mode is given. The words "advanced", "deep", or "thorough" in the user's request select **advanced**.

| Mode | What it includes |
|------|------------------|
| **simple** (default) | Resolve inputs, fetch, triage, diff review with the architecture / clean-code / test checklists, finding verification, severity-ranked report. |
| **advanced** | Everything in simple, plus existing-review-comment dedup, cross-cutting dimensions (security, performance, dependencies, migrations), optional build+tests in a temporary worktree, and reply/reaction suggestions for existing comments. |

Steps tagged **[advanced]** below are skipped entirely in simple mode; untagged steps run in both modes.

## Steps

### 1. Resolve Inputs
Determine the source branch, target branch, and (if available) PR context:
- If given a PR/MR number and a forge CLI is available, resolve the branches and pull the PR title/description as reviewer context:
  ```bash
  gh pr view <n> --json headRefName,baseRefName,title,body   # GitHub
  glab mr view <n>                                           # GitLab
  ```
  On Bitbucket, use the `bb` CLI or the REST API if configured.
- Pure-git fallback: the user supplies the source/target branch names. If no target is given, detect the default branch:
  ```bash
  git symbolic-ref refs/remotes/origin/HEAD   # if unset: git remote set-head origin --auto
  ```
- Forge CLIs are optional everywhere in this workflow: detect availability (e.g. `command -v gh`), use them when present, and fall back to pure git silently.

### 2. Update Repository
Fetch all remote branches and prune deleted ones to ensure you are comparing the latest commits:
```bash
git fetch --all --prune
```

### 3. Triage the Change
Get the size, shape, and intent of the change before reading any code:
```bash
git diff --stat origin/<target_branch>...origin/<source_branch>
git diff --name-only origin/<target_branch>...origin/<source_branch>
git log origin/<target_branch>...origin/<source_branch> --oneline
```
The commit log reveals the developer's intent and context. For large PRs (roughly >15 files or >600 changed lines), group the files by module/area and review chunk by chunk in the later steps instead of one monolithic pass. Never silently skip files — if anything is left unreviewed, say so in the report.

### 4. [advanced] Fetch Existing Review Discussion
Forge only; skip silently in pure-git mode. Purpose: never repeat feedback other reviewers already gave.
- List existing review comments and threads, including resolved ones:
  ```bash
  gh pr view <n> --comments                                  # GitHub, thread overview
  gh api repos/{owner}/{repo}/pulls/<n>/comments             # GitHub, file/line anchors + comment ids
  glab mr view <n> --comments                                # GitLab, thread overview
  glab api projects/:id/merge_requests/<n>/notes             # GitLab, note ids
  ```
  On Bitbucket, use REST `.../pullrequests/<n>/comments`.
- Keep a working summary: what was raised, by whom, at which file:line, and whether it is resolved. It is used for dedup in step 11 and for the reply/reaction sections in steps 12–13.

### 5. Inspect the Diff
Examine the exact changes introduced in the source branch:
```bash
git diff origin/<target_branch>...origin/<source_branch>
git diff origin/<target_branch>...origin/<source_branch> -- <file_path>   # single file
```
Apply two review disciplines:
- Read the surrounding context of each changed region (the whole function/class, not just the hunk) before judging it — `git show origin/<source_branch>:<file_path>` reads a file without checking it out.
- Distinguish issues *introduced by this PR* from pre-existing ones. Only the former become findings; a serious pre-existing issue may be mentioned once, clearly labeled as out of scope.

### 6. Verify Architectural & Project-Specific Compliance
Before looking at code quality, check the project's own instructions (e.g., `AGENTS.md`, `CLAUDE.md`, `.cursorrules`, or `.agent/rules/` directory):
- **Layer Separation**: Ensure strict separation of concerns (e.g., presentation/UI layers must never access database/API/repository classes directly).
- **Framework Leakage**: Keep business/domain logic free of UI framework concepts (e.g., ViewModels/controllers must not reference Context, Activity, Fragment, or framework views).
- **Dependency Injection (DI)**: Verify new dependencies are registered correctly using the project's preferred DSL and scope (e.g., lazy/factory vs singleton).
- **Type-Safe Seams**: Check that routes, navigation parameters, and events use type-safe declarations instead of loose strings.
- **Component Design**: UI elements should accept layout/style properties (like `Modifier` in Compose or classes in Web) as optional arguments to promote reuse.

### 7. Verify Clean Code & SOLID Compliance (Clean Code Guard)
Ensure the changed production code adheres to clean code and SOLID design principles in any programming language:
- **Names Reveal Intent**: Never use generic names like `data`, `result`, `temp`, `item`, or generic verbs/nouns (`do_process`, `helper`, `manager`) without qualifiers.
- **Functions Stay Small**: Target ≤ 20 lines of code, doing exactly one thing at a single level of abstraction.
- **Parameter Ceiling**: Maximum of 4 arguments. For 5+ arguments, introduce a request/config DTO object. Never use boolean flag parameters (split into two functions instead).
- **Command/Query Separation**: A function either returns a value (query) or has a side effect (command), never both.
- **Comments & Structure**: Comments explain *why*, not *what*. Delete commented-out code, unused imports, and left-over TODO comments (version control keeps history).
- **Single Responsibility (SRP)**: A module/class should have only one reason to change (be answerable to exactly one actor).
- **Open/Closed (OCP)**: Prefer extending behavior by adding new code (using interfaces, strategy patterns, or registries) instead of modifying existing conditional branches (like `if-else` or `switch`).
- **Liskov Substitution (LSP)**: Subclasses or implementations must fulfill the parent contract. Never override a method to throw `UnsupportedOperationException` or bypass a contract.
- **Dependency Inversion (DIP)**: Abstractions (interfaces) belong with the client package that consumes them, not next to the concrete implementation.
- **DRY & YAGNI**: Eliminate duplicate business knowledge. Never write speculative code (no unused parameters, flags, configs, or "just in case" exports).
- **Complexity Ceiling**: Cyclomatic complexity ≤ 10 and nesting depth ≤ 5 per function; request a refactor before exceeding.
- **Dead Code**: Flag unused imports, unused symbols, and unreachable branches introduced by the PR.
- **AI-specific Safeguards**:
  - Never swallow errors with broad catch-all handling (empty catch blocks are banned).
  - Do not add defensive null/type checks for cases already guaranteed by the type system.
  - Never return hardcoded mock/fake data from real production methods.

### 8. Verify Test Code Quality (Test Guard)
If the PR contains new or modified tests, verify they follow best practices:
- **Test Behavior, Not Implementation**: Assert return values and state changes visible to the caller. Do not assert that internal helper functions were called with specific arguments (brittle mocks).
- **Justify Mocks**: Mock only at system boundaries (network APIs, databases, filesystem, clock, random, third-party SDKs). Never mock internal helpers, DTOs, or domain entities.
- **Data-Driven Variants**: Combine tests with identical setups but different values into a single parameterized test.
- **Scenario Naming**: Name tests clearly for the scenario and expected outcome: `test_<scenario>_<expected_outcome>`.
- **Infrastructure Subject**: When database queries, schemas, or persistence logic is the subject of the test, run it against a real test database, not a mock.
- **Missing Tests**: Changed or new behavior with no covering test is a finding in itself — check test existence, not only test quality.
- **Regression Tests Are Sacred**: A PR must never delete or weaken a test that references a production issue/incident ID.

### 9. [advanced] Cross-Cutting Review Dimensions
- **Security**: No secrets/credentials in the diff; injection risks (SQL/command/path); authorization checks on new endpoints/actions; unsafe handling of untrusted input at trust boundaries.
- **Error Handling & Edge Cases**: Failure paths of new code (null/empty, timeouts, partial results); errors surfaced, not swallowed.
- **Performance**: N+1 queries, work inside loops or hot paths, unnecessary allocations, missing pagination on unbounded data.
- **Dependency Changes**: Every new dependency justified; lockfile consistent with the manifest; no unexpected major-version bumps.
- **Compatibility**: API contract changes, DB schema/migrations (backward + forward safe), serialized formats, feature flags.

### 10. [advanced] Optional Verification via Worktree
Only if a local build is feasible and the user wants it — CI owns build/test otherwise; skip gracefully when the project is not runnable locally.
```bash
git worktree add <tmpdir> origin/<source_branch>   # never disturb the user's checkout
```
- Discover the project's own commands from CI config or package scripts (e.g. `.github/workflows/`, `package.json` scripts, `Makefile`, `gradlew` tasks); run the test suite and linters/static analysis.
- Always clean up: `git worktree remove <tmpdir>` (use `--force` only if the build dirtied it).

### 11. Verify Findings Before Reporting
Anti-hallucination discipline, both modes:
- For each candidate finding, re-check that the exact file and line exist in the diff and that the PR introduced the issue. Drop anything you cannot confirm by re-reading the code.
- Review only changed lines and their blast radius. Never demand refactors of untouched code.
- **[advanced] Dedup against existing comments**: A finding already raised by another reviewer (step 4) is NOT repeated. Move it to the "already raised" bucket — agree, add nuance, or suggest a reaction instead (steps 12–13).

### 12. Format the Review Output
When presenting the review report:
1. **Explain it for a dummy first**: Start with a high-level, simplified summary of what the PR does and how it achieves its goal.
2. **Review as the reviewer**: Evaluate the code professionally, focusing on architecture, code quality, and maintainability.
3. **Severity on every finding**, ordered most severe first: 🔴 blocker · 🟠 major · 🟡 minor · 🔵 nit.
4. **Overall verdict**: **approve** / **approve with nits** / **request changes**.
5. **Format comments for easy copy-pasting**: display the file name and line number for each comment, and place the suggested change or feedback inside a copy-pasteable markdown block. When the fix is a small concrete change on GitHub, put it in a ` ```suggestion ` block so the author can apply it in one click.
6. **Consolidate repetitive comments**: If an issue occurs multiple times, write a single comment at the first occurrence, list all other file paths and line numbers where it occurs, and request a global fix.

Fill in this template:
```markdown
## Summary
<what the PR does, in plain words>

## Verdict
<approve | approve with nits | request changes>

## Findings
### 🔴 <title> — `file:line`
<comment; optional ```suggestion block>
<!-- repeat per finding, ordered by severity -->
```
**[advanced]** the template gains two more sections:
```markdown
## Already raised by others
- <quote/link existing comment> → ready-to-post reply: "<agree or add nuance>"

## Suggested reactions
- <existing comment> → 👍
```

### 13. [advanced] Post Replies & Reactions (Gated)
Forge only. NEVER auto-post. Present the proposed replies/reactions from step 12 and post only on explicit user approval:
```bash
gh api repos/{owner}/{repo}/pulls/<n>/comments/<comment_id>/replies -f body='...'   # GitHub reply
gh pr comment <n> --body '...'                                                     # GitHub top-level comment
gh api -X POST repos/{owner}/{repo}/pulls/comments/<comment_id>/reactions -f content='+1'   # GitHub reaction
glab mr note <n> -m '...'                                                           # GitLab reply
glab api -X POST projects/:id/merge_requests/<n>/notes/<note_id>/award_emoji -f name=thumbsup   # GitLab award
```
Pure-git mode: this step does not apply; everything stays copy-pasteable output.
