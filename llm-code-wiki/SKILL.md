---
name: llm-code-wiki
description: Use this repository-local code knowledge base when understanding architecture, planning code changes, reviewing diffs, navigating modules, or updating durable project documentation for this repository.
---

# LLM Code Wiki

This skill exposes the repository's local code knowledge base.

This skill is installed in the repository at `.agents/skills/llm-code-wiki`.

When this skill is used, first output:

`✨💬 我已阅读llm-code-wiki.SKILL.md`

Then read `references/index.md`, followed by only the relevant files under `references/` for the current task. Before reading each `references/` file, output:

`✨🎯 我已阅读llm-code-wiki/references：{references名称}`

Do not read every reference page at once unless the task truly requires broad repository context. Keep context focused and avoid unnecessary noise.

Use the wiki as a navigation and explanation layer, not as the source of truth. The source tree remains authoritative.

Normal coding agents are encouraged to help maintain business knowledge pages under `references/`, including `index.md`, `overview.md`, `architecture.md`, `modules.md`, `interfaces.md`, `workflows.md`, `decisions.md`, `open-questions.md`, and other source-grounded Markdown pages.

When making code changes, keeping the wiki aligned is part of the expected work when the change affects durable project knowledge. Wiki updates are expected when changes affect behavior, architecture, workflows, public interfaces, commands, configuration, data flow, module responsibilities, file structure, or important design decisions. Small formatting-only edits, comment-only changes, or mechanical cleanups with no durable knowledge change usually do not require wiki updates; say why in the final response.

Before substantial code changes, read `references/index.md` and only the relevant reference pages. After code changes, update affected source-grounded pages under `references/`, update `references/index.md` when adding a new page, and record uncertainty in `references/open-questions.md` when source evidence is incomplete. Updates must be based on source evidence and should keep repository-relative source paths. In the final response, state whether wiki pages were updated, and if not, why no wiki update was needed.

Do not modify `SKILL.md`, `references/schema.md`, or `.state.json`. When adding a new business knowledge page, update `references/index.md`. Prefer updating stale content, marking uncertainty in `references/open-questions.md`, or asking the user before deleting wiki pages.

If you find many conflicts between wiki content and source code, treat source as authoritative and update the affected `references/` pages when you can do so with source evidence. Also output:

`✨⚠️ 发现知识库与源码存在较多不一致。我会优先基于源码协助更新可确认的内容；建议随后在 Cli Diff Review 中执行 Update LLM Code Wiki 做一次整体同步。`
