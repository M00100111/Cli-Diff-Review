# Cli Diff Review

Cli Diff Review brings Cursor-style code change review to VS Code for files modified by CLI coding agents.

## Features

- Review Git working-tree changes directly from VS Code.
- Capture a snapshot baseline before running a CLI agent, then review the resulting edits.
- Inspect full-file old/current changes in a review view with red and green diff blocks.
- Accept or reject individual hunks.
- Accept or reject all changes in a file.
- Undo reviewed file decisions.
- Jump to the previous or next change.
- Use the review view for basic definition/reference navigation.

## Commands

- `Cli Diff Review: Start Git Review`
- `Cli Diff Review: Capture Baseline`
- `Cli Diff Review: Start Snapshot Review`
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
- `cliDiff.maxDiffLines`: maximum combined old and new line count diffed for one file.
- `cliDiff.maxDiffCells`: maximum old-line by new-line comparison cells diffed for one file.
- `cliDiff.maxFiles`: maximum number of files scanned for snapshot reviews.
- `cliDiff.exclude`: glob pattern excluded from snapshot scans.

## Notes

Cli Diff Review does not stage, commit, or rewrite Git history. Accepting a change marks it as reviewed in the current session; rejecting a change edits the working file back to the baseline content for that hunk.
