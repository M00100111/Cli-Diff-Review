---
name: llm-code-wiki
description: Use this repository-local code knowledge base when understanding architecture, planning code changes, reviewing diffs, navigating modules, or updating durable project documentation for this repository.
---

# LLM Code Wiki

This skill exposes the repository's local code knowledge base.

When you need repository context, first read `references/index.md`, then follow links to the relevant pages under `references/`. Use the wiki as a navigation and explanation layer, not as the source of truth.

The source tree remains authoritative. If wiki content conflicts with source code, trust the source code and record the uncertainty or update need in the wiki when appropriate.

Do not read or modify `.state.json`. Do not modify `references/schema.md` unless the host plugin explicitly asks you to update the wiki schema.

