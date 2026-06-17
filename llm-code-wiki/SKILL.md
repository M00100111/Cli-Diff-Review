---
name: llm-code-wiki
description: Use this repository-local code knowledge base when understanding architecture, planning code changes, reviewing diffs, navigating modules, or updating durable project documentation for this repository.
---

# LLM Code Wiki

This skill exposes the repository's local code knowledge base.

When this skill is used, first output:

`✨💬 我已阅读llm-code-wiki.SKILL.md`

Then read `references/index.md`, followed by only the relevant files under `references/` for the current task. Before reading each `references/` file, output:

`✨🎯 我已阅读llm-code-wiki/references：{references名称}`

Do not read every reference page at once unless the task truly requires broad repository context. Keep context focused and avoid unnecessary noise.

Use the wiki as a navigation and explanation layer, not as the source of truth. The source tree remains authoritative.

Normal coding agents may help maintain business knowledge pages under `references/`, including `index.md`, `overview.md`, `architecture.md`, `modules.md`, `interfaces.md`, `workflows.md`, `decisions.md`, `open-questions.md`, and other source-grounded Markdown pages. Updates must be based on source evidence and should keep repository-relative source paths.

Do not modify `SKILL.md`, `references/schema.md`, or `.state.json`. Prefer updating stale content, marking uncertainty, or asking the user before deleting wiki pages.

If you find many conflicts between wiki content and source code, output:

`✨⚠️ 检测到较多知识库内容可能已过期，建议在 Cli Diff Review 中执行 Update LLM Code Wiki。`
