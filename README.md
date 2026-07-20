# Cli Diff Review

Cli Diff Review brings Cursor-style code change review to VS Code for files modified by CLI coding agents.

## Features

- Review Git working-tree changes directly from VS Code.
- Inspect index-to-working-tree changes in a review view with red and green diff blocks.
- Review only Git-native working-tree hunks; already staged content stays outside the review session.
- Accept a hunk for the current review round, or reject it by restoring that hunk in the working file.
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
- `Cli Diff Review: Refresh and Stage Reviewed Changes`

## Settings

- `cliDiff.autoStartGitReview`: automatically start a Git review session for changed files.
- `cliDiff.maxFileBytes`: maximum file size included in review.
- `cliDiff.aiReviewMaxRounds`: maximum rounds for each Knowledge, Planning, File, and Integration AI Review agent; `0` means unlimited.

## Notes

Git is required. `Pending` is read from the index-to-working-tree patch. `Accepted` and `Rejected` are restored from the extension's private review journal while the current review round is active.

Accept records the selected Git hunk without changing the index. Reject modifies the saved working file immediately. Undo is available until a manual Refresh. Refresh stages all still-valid Accepted hunks, finalizes Rejected hunks, and starts a clean review round. Save or revert dirty editors before using review mutations. Commit, checkout, or reset changes HEAD and starts a new review session for that repository.

AI Review does not impose a separate Tool Call limit. If an Agent fails or is cancelled after completing a round, `Continue AI review` resumes from the saved conversation and Tool Results while the Git baseline, model, prompts, and tools remain compatible. Applying an AI Suggestion regenerates its Git patch; undoing an accepted Suggested chunk restores the original Pending text.
