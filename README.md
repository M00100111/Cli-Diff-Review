# CLI Diff

CLI Diff brings Cursor-style code change review to VS Code for files modified by CLI coding agents.

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

- `CLI Diff: Start Git Review`
- `CLI Diff: Capture Baseline`
- `CLI Diff: Start Snapshot Review`
- `CLI Diff: Open Review`
- `CLI Diff: Accept Change`
- `CLI Diff: Reject Change`
- `CLI Diff: Accept File`
- `CLI Diff: Reject File`
- `CLI Diff: Undo File`
- `CLI Diff: Next Change`
- `CLI Diff: Previous Change`
- `CLI Diff: Refresh Review`

## Settings

- `cliDiff.autoStartGitReview`: automatically start a Git review session for changed files.
- `cliDiff.maxFileBytes`: maximum file size included in review.
- `cliDiff.maxDiffLines`: maximum combined old and new line count diffed for one file.
- `cliDiff.maxDiffCells`: maximum old-line by new-line comparison cells diffed for one file.
- `cliDiff.maxFiles`: maximum number of files scanned for snapshot reviews.
- `cliDiff.exclude`: glob pattern excluded from snapshot scans.

## Notes

CLI Diff does not stage, commit, or rewrite Git history. Accepting a change marks it as reviewed in the current session; rejecting a change edits the working file back to the baseline content for that hunk.
