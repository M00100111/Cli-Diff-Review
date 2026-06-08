# LLM Code Wiki

A local, LLM-maintained code knowledge base for a software repository.

This document adapts the general LLM Wiki pattern to source code. Its purpose is to guide an LLM to initialize and maintain a persistent `.wiki` directory inside a user's project, so the codebase can be understood once, organized into durable markdown pages, and reused by future coding, review, and navigation workflows.

## Core idea

Most AI coding tools repeatedly rediscover a repository from raw files. They search, read scattered source files, infer architecture, answer the immediate question, and then discard most of that understanding.

LLM Code Wiki is different. The LLM compiles a persistent code knowledge layer: a structured set of markdown files that describes the project architecture, modules, workflows, APIs, important decisions, and code relationships. The wiki sits between the raw source tree and future AI features. It is not a replacement for source code; it is a maintained map of the source code.

The source tree remains the source of truth. The wiki is the navigational and explanatory layer.

## Goals

- Build a local `.wiki` folder in the project root.
- Capture the repository's current structure, responsibilities, and major workflows.
- Keep pages small enough to be useful to both humans and LLMs.
- Link related modules, files, commands, and concepts.
- Cite source file paths whenever making code-specific claims.
- Make uncertainty explicit instead of inventing missing facts.
- Provide a foundation for future AI code review, code search, and update workflows.

## Non-goals for the MVP

- No embedding index is required.
- No semantic search is required.
- No automatic update workflow is required.
- No code review suggestions are generated yet.
- No source files are modified.
- The LLM may only propose files under `.wiki`.

## Repository layers

**Raw code** is the immutable source of truth for wiki initialization. The LLM reads source files, manifests, tests, configuration, and documentation, but it must not edit them.

**Workspace digest** is the bounded context prepared by the VS Code extension. It may include project metadata, file inventory, selected file contents, package scripts, extension manifest details, and summaries of large files.

**The wiki** is the generated `.wiki` directory. It contains markdown pages owned by the LLM.

**The schema** is `.wiki/schema.md`. It documents the page conventions, linking rules, update rules, and expected behavior for future wiki maintenance.

## Required initial structure

The initialization response must create these files:

- `index.md`: entry point and catalog of all wiki pages.
- `overview.md`: concise explanation of what the project does.
- `architecture.md`: major subsystems, boundaries, and data flow.
- `extension-surface.md`: VS Code commands, views, activation events, configuration, and user-facing surfaces.
- `workflows.md`: important runtime workflows, especially review flow and wiki initialization flow.
- `modules.md`: module responsibility map with source file references.
- `decisions.md`: inferred design decisions and tradeoffs.
- `open-questions.md`: uncertain or incomplete findings.
- `schema.md`: conventions for maintaining the wiki.
- `log.md`: chronological initialization and maintenance log.

The LLM may add extra pages only when they clearly improve navigation, for example `modules/review-dashboard.md` or `workflows/git-review.md`.

## Page conventions

Each page should be markdown and should favor concise, source-grounded explanations.

Use relative links between wiki pages, for example `[Architecture](architecture.md)`. Use source references as plain repository paths, for example `src/reviewController.ts`.

When documenting a module, include:

- Responsibility
- Important collaborators
- User-facing behavior if any
- Key data structures or message shapes
- Source files
- Known uncertainties

When documenting a workflow, include:

- Trigger
- Main steps
- Important state transitions
- Files or modules involved
- Failure or cancellation behavior

## Strict JSON response contract

The LLM must return only a JSON object. It must not wrap the response in markdown fences and must not include prose outside JSON.

The response shape is:

```json
{
  "version": 1,
  "summary": "Short summary of the generated wiki.",
  "files": [
    {
      "path": "index.md",
      "content": "Markdown content"
    }
  ],
  "warnings": [
    "Optional uncertainty or limitation"
  ]
}
```

Rules:

- `files` must be a non-empty array.
- Every `path` must be a relative path inside `.wiki`.
- Paths must not be absolute and must not contain `..`.
- File contents must be markdown text.
- The required initial files must be present.
- If the model lacks enough evidence, it must write that uncertainty into `open-questions.md`.

## Initialization workflow

1. The VS Code extension verifies that `base_url`, `model`, and `api_key` are configured.
2. The user clicks the initialize button in the Activity Bar view.
3. The extension builds a workspace digest from the current project.
4. The extension sends this document and the workspace digest to the configured LLM.
5. The LLM returns the strict JSON object described above.
6. The extension parses the response with standard JSON parsing only.
7. The extension validates paths and required files.
8. The extension writes the files into `.wiki`.
9. The extension appends an initialization entry to `.wiki/log.md`.

## Cancellation behavior

While initialization is running, the user may cancel.

Pause means stop the current request or write sequence and keep any generated `.wiki` files.

Revert means stop the current request or write sequence and delete the project root `.wiki` directory.

The extension must never delete anything outside the exact project-root `.wiki` directory.

## Quality rules

- Prefer accurate small pages over broad speculative pages.
- Do not describe a function, class, command, or file unless there is source evidence.
- If a claim is inferred, say so.
- Prefer source paths over vague references.
- Keep the wiki useful for future LLM context loading.
- Avoid duplicating large code snippets.
- Do not include secrets, API keys, environment values, or private user data.

## Future operations

**Update** will compare changed source files against the existing wiki and revise affected pages.

**Query** will answer questions by reading `index.md`, then relevant wiki pages, then source files if needed.

**Lint** will check for stale claims, missing links, orphan pages, weak source references, and unresolved open questions.

**AI code review** can reuse the same LLM client, strict JSON parsing, workspace digest, and wiki context to produce source-grounded review suggestions.
