# Cli Diff Review

Cli Diff Review brings Cursor-style code change review to VS Code for files modified by CLI coding agents.

## Features

- Review Git working-tree changes directly from VS Code.
- Inspect HEAD-to-working-tree changes in a review view with red and green diff blocks.
- Review Git-native hunks from both the index and working tree.
- Accept a hunk by staging it, or reject it by restoring that hunk in the working file.
- Accept or reject all changes in a file.
- Undo reviewed file decisions.
- Jump to the previous or next change.
- Use the review view for basic definition/reference navigation.

## Commands

- `Cli Diff Review: Start Git Review`
- `Cli Diff Review: Open Review`
- `Cli Diff Review: Accept Change`
- `Cli Diff Review: Reject Change`
- `Cli Diff Review: Accept File`
- `Cli Diff Review: Reject File`
- `Cli Diff Review: Undo File`
- `Cli Diff Review: Next Change`
- `Cli Diff Review: Previous Change`
- `Cli Diff Review: Refresh Review`

## Settings

- `cliDiff.autoStartGitReview`: automatically start a Git review session for changed files.
- `cliDiff.maxFileBytes`: maximum file size included in review.

## Notes

Git is required. `Pending` is read from the index-to-working-tree patch, `Accepted · Staged` is read from the HEAD-to-index patch, and `Rejected` is restored from the extension's private review journal.

Accept stages the selected Git hunk immediately. Reject modifies the saved working file immediately. Undo reverses only the selected accepted or rejected patch. Save or revert dirty editors before using Accept, Reject, or Undo. Commit, checkout, or reset changes HEAD and starts a new review session for that repository.
