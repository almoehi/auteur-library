# CLAUDE.md

## Git worktrees

- Create every git worktree inside this repo's `_worktrees/` folder: `git worktree add _worktrees/<name> -b <branch> <base>`. Never create worktrees as sibling folders next to the repo (e.g. `~/work/auteur-library-<name>` or `~/work/auteur-library-worktrees/<name>`).
- `_worktrees/` is gitignored. Remove a worktree (`git worktree remove _worktrees/<name>`) once its branch is merged.
