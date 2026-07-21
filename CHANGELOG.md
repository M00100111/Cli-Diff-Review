# Changelog

## 0.0.1

- Replace snapshot and in-extension LCS review with Git-native patch review.
- Add hunk-level stage, reject, precise undo, next, and previous commands.
- Restore rejected changes across restarts while repository HEAD is unchanged.
- Add a review view with red and green diff blocks.
- Add inline editor decorations and review tree integration.
- Review only index-to-working-tree changes; staged-only content is excluded.
- Keep Accepted hunks in the extension journal and stage them only on manual Refresh.
- Invalidate reviewed hunks when overlapping working-tree edits replace them.
- Remove the spinning review-action indicator while retaining duplicate-click protection.
- Make AI Review Max Rounds apply independently to every review Agent and remove Tool Call count limits.
- Persist per-round AI Review checkpoints and continue failed reviews without rerunning completed stages or files.
- Regenerate Git hunks after applying AI Suggestions and restore the original Pending text when undoing an accepted Suggestion.
- Validate AI Suggestion ownership from the saved before/after file states and group split Git hunks into one atomic review chunk.
- Keep Findings and Suggestions on one stable chunk card across Accept, Reject, and Undo transitions.
- Remove the duplicate current-file Finding summary and render Activity Bar chunks as always-visible cards without expand/collapse behavior.
- Preserve AI Findings and Suggestions when Reject changes later chunk coordinates by using content-stable review signatures and identities.
