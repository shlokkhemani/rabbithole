# Repositories and Evidence

Nora researches code through immutable Git worktrees acquired into a shared
cache. Evidence records cite exact commits and forge permalinks instead of
mutable local paths.

## Cache Layout

The repository cache lives under VS Code `ExtensionContext.globalStorageUri`:

```text
git/
  bare/<sha256-acquisition-url>
  worktrees/<repository-id>/<commit-sha>
```

`repository-id` is the SHA-256 of the sanitized acquisition URL. Bare clones are
shared across documents. Detached worktrees are reference-counted by open
documents and pruned when no document retains them. Bare caches are not deleted
during normal document disposal.

Complete clones and worktrees are derived cache, not portable document state.
They are not embedded in `.nora`.

## Acquisition

`Nora: Add Repository` supports:

- Remote HTTPS, HTTP, SSH URL, and SCP-style Git remotes.
- Local Git repositories.

Remote acquisition clones or fetches the bare cache, resolves the requested
revision or fetched default branch, and creates a detached worktree at the exact
commit.

Local acquisition mirrors the local repository into the same bare-cache layout
and researches committed bytes at exact HEAD or the selected revision. Nora does
not read uncommitted local working-tree changes.

All Git network, proxy, SSH, certificate, and credential behavior is delegated to
system Git. Nora does not implement forge authentication and does not store Git
credentials.

## Remote Normalization

Nora rejects acquisition URLs containing URL passwords, URL userinfo for HTTP(S),
SSH passwords, or credential-bearing query parameters.

Nora stores and hashes sanitized acquisition URLs. Sanitized remotes preserve the
repository identity and non-secret query values but exclude credentials.

Known hosts are classified automatically:

- `github.com`: GitHub.
- `gitlab.com`: GitLab.
- `bitbucket.org`: Bitbucket Cloud.

Unknown hosts require the user to choose GitHub Enterprise, GitLab
self-managed, or Bitbucket Data Center before Nora can create forge permalinks.
If no forge type is known, Nora can still research the repository, but code
evidence will not include a forge permalink.

## Local Repository Remote Precedence

For a local repository, Nora chooses permalink remotes in this order:

1. Current branch upstream remote.
2. `origin`.
3. Explicit user choice when multiple remotes remain.

Before minting a permalink for a local repository, Nora fetches the selected
remote and proves the selected commit is reachable from one of its remote
tracking refs. If the commit is unpublished, Nora asks the user to select a
fetched upstream revision or to push first. Nora does not emit known-broken
permalinks for unpublished local commits.

## Permalink Forms

GitHub:

```text
<base>/<owner>/<repo>/blob/<sha>/<path>#L<start>-L<end>
```

GitLab:

```text
<base>/<namespace>/<repo>/-/blob/<sha>/<path>#L<start>-<end>
```

Bitbucket Cloud:

```text
<base>/<workspace>/<repo>/src/<sha>/<path>#<filename>-<start>
```

Bitbucket Cloud's permalink shape guarantees the start anchor. Nora retains the
end line in the evidence record.

Bitbucket Data Center:

```text
<base>/projects/<project>/repos/<repo>/browse/<path>?at=<sha>
```

Data Center line anchor support varies by server release. Nora retains
start/end lines and excerpt in evidence.

All path and query components are percent encoded while preserving `/` path
separators.

## Evidence Records

Repository source records use type `git-repository` and include:

- Repository ID.
- Sanitized remote.
- Exact commit.
- Capture time.
- Nora extension metadata for acquisition URL, forge type, and forge base URL.

Code evidence records include:

- Repository ID.
- Relative path.
- Commit SHA.
- Start and end lines.
- Excerpt.
- Immutable permalink when available.
- Sanitized acquisition and forge metadata.

Repository paths must be non-empty relative paths. Absolute paths, traversal,
symlink escapes, device files, and paths outside the acquired worktree are
rejected by Nora's code tools.

Refresh creates a new repository revision and new evidence. Existing evidence
already pinned to an older SHA is never rewritten.
