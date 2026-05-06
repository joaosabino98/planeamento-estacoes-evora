---
name: create-release
description: 'Creates an incremental GitHub release for Mobilidade e Território (Évora) — asks for patch/minor/major (SemVer), only publishes from `main` or `develop` (with `HEAD` synced with `origin`), ensures README/instructions are up to date, writes the changelog in European Portuguese following the pattern of previous releases, validates with the user before publishing, and creates tag + release via `gh`.'
---

# Create Incremental Release

Workflow to prepare and publish a new GitHub release for this repository.

## When to use

- The user asks for a "release", "new version", "new tag", or to "publish a version".
- After finishing a coherent set of changes that should be shipped together.

## Terminology

Use strict **SemVer** (`X.Y.Z`):

| Type | Bump | Example |
|------|------|---------|
| **patch** | `Z` (`X.Y.Z` → `X.Y.(Z+1)`) | `2.0.2 → 2.0.3` |
| **minor** | `Y`, reset `Z` (`X.Y.Z` → `X.(Y+1).0`) | `2.0.2 → 2.1.0` |
| **major** | `X`, reset `Y.Z` (`X.Y.Z` → `(X+1).0.0`) | `2.0.2 → 3.0.0` |

## Procedure

### 1. Check the branch and sync with `origin`

**Mandatory prerequisite.** The release is always created from `main` or `develop`, and `HEAD` must match `origin/<branch>`.

```bash
git rev-parse --abbrev-ref HEAD
git fetch --quiet origin && git rev-parse HEAD && git rev-parse @{u}
```

If the current branch is not `main` or `develop`, **stop and alert the user** with the current branch before proceeding.

If `HEAD` ≠ `@{u}` (local commits to push, or remote ahead), stop and ask how to proceed. Do not run `push --force` or `reset --hard`.

### 2. Determine the current and next versions

```bash
gh release list --limit 5
```

The latest tag is the current version. Tags in this repo do **not** carry a `v` prefix (e.g. `2.0.2`, not `v2.0.2`).

### 3. Ask the user for the bump type

If the user has not said yet, ask with options `patch` / `minor` / `major`. Show the current version and what each option would produce (e.g. "current `2.0.2` → patch `2.0.3`, minor `2.1.0`, major `3.0.0`").

### 4. Ensure documentation is up to date

Check and update **if needed** these files (repo rule: README/instructions must reflect changes to routes, state, algorithms, "do not regress" rules):

- `README.md` — sections "Funcionalidades", "Configuração por variáveis de ambiente", "API".
- `.github/copilot-instructions.md` — "do not regress" rules, list of routes, etc.
- `.github/instructions/architecture.instructions.md` — API contracts, frontend state, algorithms.

Use the diff since the last tag to identify what changed:

```bash
git diff <current-tag>..HEAD
```

If a change is missing from the docs, update **before** continuing and mention it to the user.

### 5. Write the changelog following the pattern

From the same diff (`git diff <current-tag>..HEAD`), draft the changelog.

The changelog is in **European Portuguese** and uses this format (see releases `2.0.0`, `2.0.1`, `2.0.2` as reference):

```markdown
## Changelog — v<previous> → v<new>

<optional context paragraph, especially in releases dedicated to a single theme>

### Novas funcionalidades

- <user-visible feature, in a complete sentence>

### Melhorias

- <impactful refactors, performance, UX, safer defaults>

### Correções

- <bug fix described from the user's point of view, followed by "Corrigido."
  or a short technical explanation when relevant>

### Documentação

- <updates to README, copilot-instructions, new "do not regress" rules>
```

Guidelines (not strict — adapt to the release content):

- Omit empty sections. A release with only fixes may not have "Novas funcionalidades".
- Each bullet starts with the "headline" of the problem/feature, followed by the explanation. Use `inline code` for file names, routes, functions, variables.
- When there is a dominant theme (e.g. "release dedicated to hardening"), open with a short paragraph stating it.
- Do not invent changes that are not in the diff. If a change looks small but is critical (e.g. an algorithm change), mention it anyway.
- Mention new or removed "do not regress" rules under "Documentação".

### 6. Validate the changelog with the user

**Mandatory step.** Show the full changelog (as text, not in a file) and ask:

> "Pronto a publicar como `<new-tag>`? Diz-me se queres ajustar alguma secção."

Wait for explicit confirmation. Iterate on the changelog if the user requests changes.

### 7. Publish the release

After confirmation:

1. Make sure everything is committed and pushed on the current branch (`main` or `develop`):
   ```bash
   git status --porcelain && git push
   ```
   If there are uncommitted changes from step 4, ask the user whether to commit and with which message (do not use `--force` or `--no-verify`).

2. **Only for `major`: promote `main` to the tip of `develop`.** If the release is being made from `develop` and `main` is behind, fast-forward `main` to `develop` *before* creating the tag, so `main` ends up on the commit that will be tagged.

   ```bash
   # Check whether main is behind develop (ancestor)
   git fetch --quiet origin
   git merge-base --is-ancestor origin/main origin/develop && echo "main is behind"
   ```

   If `main` is behind (ancestor), ask the user for confirmation and then:

   ```bash
   git checkout main
   git pull --ff-only origin main
   git merge --ff-only develop
   git push origin main
   git checkout develop
   ```

   If the fast-forward fails (main has commits develop does not have), **stop and report** — do not perform a non-fast-forward merge, rebase or `--force` without explicit instruction from the user.

   If the `major` release is being made directly from `main`, skip this step.

3. Write the changelog to a temporary file (preserves newlines and formatting):
   ```bash
   cat > /tmp/release-<new>.md <<'EOF'
   <full changelog>
   EOF
   ```

4. Create the release. The title is just the version number (without `v` prefix). **Always pass `--target <branch>` explicitly** — without it, `gh` uses the repo's *default* branch (`main`), not the branch you are on locally, and the tag ends up on the wrong commit. Confirm the current branch first with `git rev-parse --abbrev-ref HEAD` and use that value (`main` for `major` after the fast-forward, `develop` for `patch`/`minor` made from `develop`):

   ```bash
   BRANCH=$(git rev-parse --abbrev-ref HEAD)
   gh release create <new> --target "$BRANCH" --title "<new>" --notes-file /tmp/release-<new>.md
   ```

   This automatically creates the tag `<new>` at `HEAD` of the target branch. Confirm right after that it landed on the correct commit:

   ```bash
   gh release view <new> --json tagName,targetCommitish
   git rev-parse "$BRANCH" && git rev-list -n 1 <new>
   ```

   The two SHAs must match. If they do not, delete with `gh release delete <new> --cleanup-tag --yes` and recreate with the right `--target`.

5. Confirm with the user, showing the URL returned by `gh`.

## Safety notes

- Do not run `git push --force`, `git reset --hard`, or rewrite already-published history.
- Do not create the release before the user validates the changelog.
- If `gh release create` fails (tag exists, no permissions, etc.), stop and report — do not try to work around it.
