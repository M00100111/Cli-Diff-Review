# LLM Code Wiki Schema

This file defines the operating rules for an LLM-maintained, repository-local code knowledge base stored as a project skill.

The source tree is always the source of truth. `.skills/llm-code-wiki` is a compact navigation and explanation layer for humans and coding agents. It must describe the repository that contains it, not the tool that generated it.

## Structure

- `SKILL.md`: short entry point for coding agents.
- `references/schema.md`: this maintenance schema.
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

The Agent may read source files and wiki pages through the tools provided by the host plugin.

The Agent may write only generated Markdown files inside `.skills/llm-code-wiki/references`.

The Agent must never:

- Modify repository source files.
- Modify `.skills/llm-code-wiki/SKILL.md`.
- Modify `.skills/llm-code-wiki/references/schema.md`.
- Modify `.skills/llm-code-wiki/.state.json`.
- Write outside `.skills/llm-code-wiki/references`.
- Invent repository facts that are not supported by source evidence.

For initialization, inspect the repository before creating all required pages.

For updates, inspect changed source files and related wiki pages, then revise only affected wiki content. Update cross-links and append an entry to `references/log.md`.

## Host Agent protocol

When operating through the host plugin, return only the strict JSON action format requested by the host. Do not wrap JSON in Markdown fences and do not include explanatory prose outside JSON.

Use tool calls for repository inspection and wiki writes. Finish with a final JSON result containing a short `summary` and optional `warnings`.

## Completion

Before completing initialization, ensure every required page exists under `references/`.

Before completing an update, ensure changed code is reflected consistently across affected pages and the update is recorded in `references/log.md`.
