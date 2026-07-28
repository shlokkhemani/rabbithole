# Nora

Nora is a VS Code extension for conducting research across project codebases and corporate sources on an infinite canvas.

## Language

**Research**: An investigation conducted on an infinite canvas using material from codebases and corporate sources.
_Avoid_: Rabbithole, hole, diagram

**Research Canvas**: The infinite canvas opened from a `.nora` file where research material and branches are explored.
_Avoid_: Vector editor, drawing canvas

**Source Reference**: Durable provenance attached to research material, identifying its original code or corporate source, stable locator, cited excerpt, and available revision.
_Avoid_: Unattributed copy

**Repository Permalink**: An immutable GitHub, GitLab, or Bitbucket URL pinned to an exact commit, file path, and optional line range.
_Avoid_: Branch link, local file path

**Research Prompt**: A transient request to Pi, scoped to the selected canvas node or to the whole research when nothing is selected.
_Avoid_: Chat message, permanent chat panel

**Agent Run**: One Pi execution started by a Research Prompt. Its output becomes canvas material, while its complete execution history remains stored in the `.nora` artifact and is available through run details.
_Avoid_: Chat thread
