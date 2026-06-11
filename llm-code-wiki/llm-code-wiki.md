# LLM Code Wiki

This file defines the operating rules for an LLM-maintained, repository-local code knowledge base.

The source tree is always the source of truth. The `.wiki` directory is a compact navigation and explanation layer for humans and coding agents. It must describe the repository that contains it, not the tool that generated it.

## Goals

- Explain what the repository does and how its major parts collaborate.
- Capture important modules, interfaces, workflows, and design decisions.
- Ground every code-specific claim in repository paths.
- Keep pages concise, linked, and useful as future code-review context.
- Update existing pages when code changes instead of duplicating stale explanations.
- Record uncertainty explicitly in `open-questions.md`.

## Required pages

- `index.md`: entry point and catalog of Wiki pages.
- `overview.md`: project purpose, users, and major capabilities.
- `architecture.md`: subsystem boundaries and data flow.
- `modules.md`: module responsibility map with source references.
- `interfaces.md`: important public APIs, commands, protocols, and data shapes.
- `workflows.md`: important runtime and development workflows.
- `decisions.md`: inferred or documented design decisions and tradeoffs.
- `open-questions.md`: uncertainties and incomplete findings.
- `log.md`: append-only history of Wiki initialization and updates.

Additional Markdown pages may be created when they improve navigation. Prefer a small number of useful pages over many shallow pages.

## Page conventions

- Use relative links between Wiki pages.
- Reference source files using repository-relative paths.
- Do not copy large code blocks into the Wiki.
- Mark inferred claims as inferred.
- Keep existing useful human-written Wiki content unless source evidence makes it stale.
- Never include secrets, API keys, environment values, or private user data.

When documenting a module, include its responsibility, collaborators, public behavior, important data structures, source files, and known uncertainties.

When documenting a workflow, include its trigger, main steps, state transitions, involved modules, and failure behavior.

## Agent rules

The Agent may read source files and Wiki pages through the tools provided by the host plugin.

The Agent may write only generated Markdown files inside `.wiki`.

The Agent must never:

- Modify repository source files.
- Modify `.wiki/llm-code-wiki.md`.
- Modify `.wiki/.state.json`.
- Write outside `.wiki`.
- Invent repository facts that are not supported by source evidence.

For initialization, inspect the repository before creating all required pages.

For updates, inspect changed source files and related Wiki pages, then revise only affected Wiki content. Update cross-links and append an entry to `log.md`.

## Completion

Before completing initialization, ensure every required page exists.

Before completing an update, ensure changed code is reflected consistently across affected pages and the update is recorded in `log.md`.
