---
name: commit-suggest
description: Suggest a commit message for the current changes following this project's commit message guide. Use when asked to suggest, draft, propose, or write a commit message for the staged/unstaged changes.
---

# commit-suggest

Inspect the current working-tree changes and propose a commit message that
follows the commit message rules embedded below. This skill **suggests only** —
it never runs `git commit`. Present the message and let the user decide.

## Steps

1. **Gather the changes.** Run these to see what is actually changing:

   ```bash
   git status --short
   git diff HEAD --stat
   git diff HEAD
   ```

   `git diff HEAD` shows staged + unstaged together. If the diff is very large,
   fall back to `git diff HEAD --stat` plus reading the most relevant hunks —
   the message must reflect the *real* change, not a guess from filenames.

2. **Derive the ticket ID** from the branch name (branches look like
   `feature/PROJ-47-...`):

   ```bash
   git rev-parse --abbrev-ref HEAD | grep -oE '[A-Z]+-[0-9]+' | head -1
   ```

   Use it as the `[TICKET-ID]` prefix. If none is found, omit the prefix and
   note that no ticket ID was detected.

3. **Compose the message** following the rules in the section below.

4. **Present the suggestion** in a fenced ```text block so the user can copy it.
   If the staged and unstaged sets differ meaningfully, mention which files are
   staged vs. not, since `git commit` without `-a` would only capture the staged
   ones. Do not commit.

## Notes
- End the message with the required co-author trailer only if the user asks to
  actually commit — suggestions stay clean.
- This repo's convention puts the ticket ID in `[BRACKETS]`; recent history uses
  prefixes like `[PROJ-24]`, `[PROJ-101]`.

---

## Commit Message Rules

### Recommended Format

```text
[TICKET-42] Write header in imperative form without period

After a blank line, optionally add more details about the change.
Explain the "why" here, while the header focuses on the "what".

- Bullet points can be used
- Add technical clarifications when needed
- Keep lines around 80 characters
```

### Header

- Always include the ticket ID in `[BRACKETS]` if available (e.g. `[ABC-1234]`,
  `[PROJ-26]`, `[XYZ-10592]`).
- Use **imperative form** — start with a present-tense verb: `Add`, `Fix`,
  `Refactor`, `Update`, `Remove`, `Migrate`. Never use past tense (`Fixed`,
  `Fixes`).
- No trailing period.
- Keep it short and focused on the *what*.

### Body

- Explain the **why**: the issue it solves, business/technical motivation, or
  context that future developers need.
- Do **not** restate the diff or describe line-by-line what changed.
- For **bug fixes**, use `**Issue**` / `**Solution**` sections:

  ```text
  [XYZ-10592] Enhance light button delay

  **Issue**
  When the user clicks on the light button, it takes several seconds
  (from 2 to 15 seconds) to reflect the new UI state. This creates
  ambiguity and may cause the user to repeatedly press the button,
  leading to inconsistent backend state updates.

  **Solution**
  Update the UI state immediately before sending the backend request.
  If the request succeeds, keep the current state. Otherwise, revert
  to the previous state.
  ```

- For **new features**, use a `**Changes**` section with bullet points:

  ```text
  [ABC-1234] Display a banner indicating the network status

  **Changes**
  - Add an observer to detect network status
  - Display a corresponding banner depending on connectivity state
  ```

- Feature commits with obvious scope may use a concise title-only message.

### What to Avoid

- Vague or meta messages: `fix previous commit`, `apply PR comments`,
  `minor fixes`, `WIP`. Instead, amend before pushing or describe the actual
  change.
- Describing *how* the code works (that belongs in code comments).
- More than one blank line between sections.

### Quick Checklist

- [ ] Ticket ID included (if available)
- [ ] Imperative form verb
- [ ] Header clearly states the technical change, no trailing period
- [ ] Body explains the *why*, not the *what*
- [ ] No vague/meta descriptions
- [ ] Concise but informative
