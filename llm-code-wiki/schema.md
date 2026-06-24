# LLM Code Wiki Schema

This file defines the operating rules for an LLM-maintained, repository-local code knowledge base stored as a project skill.

The source tree is always the source of truth. `.agents/skills/llm-code-wiki` is a compact navigation and explanation layer for humans and coding agents. It must describe the repository that contains it, not the tool that generated it.

## Structure

- `SKILL.md`: short entry point for coding agents.
- `references/schema.md`: this maintenance schema, reserved for host plugin maintenance rules.
- `references/index.md`: entry point and catalog of wiki pages.
- `references/overview.md`: project purpose, users, and major capabilities.
- `references/architecture.md`: subsystem boundaries and data flow.
- `references/modules.md`: module responsibility map with source references.
- `references/interfaces.md`: important public APIs, commands, protocols, and data shapes.
- `references/workflows.md`: important runtime and development workflows.
- `references/decisions.md`: inferred or documented design decisions and tradeoffs.
- `references/open-questions.md`: uncertainties and incomplete findings.
- `references/log.md`: append-only history of wiki initialization and updates.

Additional Markdown pages may be created under `references/` when they improve navigation. Prefer a small number of useful pages over many shallow pages.

`references/index.md` should catalog business knowledge pages. Do not list `references/schema.md` as a normal knowledge page. If needed, mention that `schema.md` is reserved for host plugin maintenance.

## Goals

- Explain what the repository does and how its major parts collaborate.
- Capture important modules, interfaces, workflows, and design decisions.
- Ground every code-specific claim in repository paths.
- Keep pages concise, linked, and useful as future code-review context.
- Update existing pages when code changes instead of duplicating stale explanations.
- Record uncertainty explicitly in `references/open-questions.md`.

## Page conventions

- Use relative links between wiki pages.
- Reference source files using repository-relative paths.
- Do not copy large code blocks into the wiki.
- Mark inferred claims as inferred.
- Keep existing useful human-written wiki content unless source evidence makes it stale.
- Never include secrets, API keys, environment values, or private user data.

When documenting a module, include its responsibility, collaborators, public behavior, important data structures, source files, and known uncertainties.

When documenting a workflow, include its trigger, main steps, state transitions, involved modules, and failure behavior.

## Agent rules

There are three agent roles:

- `Host Wiki Agent`: the Cli Diff Review plugin Agent that initializes, updates, validates, and synchronizes the wiki.
- `Normal coding agent`: an external coding agent such as Codex or Claude Code that may use and improve business wiki pages while coding.
- `AI Review Agent`: the Cli Diff Review review Agent that may read wiki context for code review but must not modify wiki files.

The Host Wiki Agent may read source files and wiki pages through the tools provided by the host plugin. It may write generated Markdown files inside `.agents/skills/llm-code-wiki/references`.

Normal coding agents are encouraged to edit business knowledge pages under `.agents/skills/llm-code-wiki/references` when the edits are grounded in source evidence. When making code changes, keeping the wiki aligned is part of the expected work when the change affects durable project knowledge. Wiki updates are expected when changes affect behavior, architecture, workflows, public interfaces, commands, configuration, data flow, module responsibilities, file structure, or important design decisions.

Normal coding agents should update the wiki while coding when they learn durable project knowledge, keep repository-relative source paths, and update `references/index.md` when adding a new business knowledge page. Small formatting-only edits, comment-only changes, or mechanical cleanups with no durable knowledge change usually do not require wiki updates; agents should say why in the final response. Wiki updates must be based on source evidence to avoid low-value documentation churn.

The AI Review Agent treats source and wiki files as read-only.

`.state.json` is private plugin state and may be updated only by the host plugin.

When maintaining the wiki, agents must never:

- Modify repository source files as part of wiki maintenance.
- Modify `.agents/skills/llm-code-wiki/SKILL.md`.
- Modify `.agents/skills/llm-code-wiki/references/schema.md`.
- Modify `.agents/skills/llm-code-wiki/.state.json`.
- Invent repository facts that are not supported by source evidence.

For initialization, inspect the repository before creating all required pages.

For plugin-driven updates, inspect changed source files and related wiki pages, then revise only affected wiki content. Preserve and integrate source-grounded wiki edits made by normal coding agents. Update cross-links and append an entry to `references/log.md`.

Normal coding agents should avoid deleting wiki pages. If content appears stale, update it, mark uncertainty, or tell the user that the wiki should be refreshed by the plugin.

## Host Agent protocol

When operating through the host plugin, return only the strict JSON action format requested by the host. Do not wrap JSON in Markdown fences and do not include explanatory prose outside JSON.

Use tool calls for repository inspection and wiki writes. Finish with a final JSON result containing a short `summary` and optional `warnings`.

## Completion

Before completing initialization, ensure every required page exists under `references/`.

Before completing an update, ensure changed code is reflected consistently across affected pages and the update is recorded in `references/log.md`.
