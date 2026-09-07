# Spec: AI-generated images — `generate_image`

Status: draft for review, 2026-09-07. Product decisions locked in conversation
that day; mechanics verified against codex-cli 0.153.4 (see §11).

## 1. Problem

A learner reading about a medieval water mill, a leaf cross-section, or a loss
surface sometimes wants to *see* it. Prose cannot do that, and the Show
primitive (HTML/CSS/SVG the model authors) cannot do photoreal, painterly,
spatial, historical, or "redraw this figure" work. The Codex CLI ships a
built-in image generation tool that needs no API key and runs on the learner's
existing ChatGPT plan. Rabbithole should let the answering agent make a picture
and put it in the card.

## 2. Structural principles (normative)

An implementation that violates one of these is wrong even if it looks right.

1. **The trigger is language, not chrome.** No lens, no preset pill, no
   toggle. The learner writes "draw", "illustrate", "sketch", "show me a
   picture of" in an ordinary ask. Model guidance teaches the recognition.
   Autonomous illustration (the model deciding on its own) is a later
   guidance change, not plumbing; v1 guidance says *only when asked*.
2. **The agent decides and the agent sees.** `generate_image` is an MCP tool
   on the rabbit-hole server. Its result carries the PNG as an MCP image
   content block, so the answering model looks at what it made and may call
   again to fix a wrong label. The executor is hidden: the host spawns Codex
   whether the agent is Claude Code, Codex, or anything else.
3. **A generated image is an ordinary asset.** It lands in the hole's asset
   store and is referenced from the answer markdown as
   `![caption](asset:gen-xxxxxxxx.png)`. No new node type, no new fence, no
   new wire event for content. Lightbox, resize, GC, portable export, frozen
   snapshot, and Share all work unchanged.
4. **Text never waits behind pixels.** Guidance: stream the prose first with
   `answer_branch { partial: true }`, then call `generate_image`, then send
   the final chunk containing the image line. The host flips the pending card
   to a `drawing` work state for the duration of the call (~80 s).
5. **Provenance travels with the node.** The extension namespace
   `generated_images` on the answer node maps asset name →
   `{ thread_id, prompt, revised_prompt, aspect, edit_of, created_at }`.
   It persists and exports portably. Frozen snapshots drop arbitrary
   namespaces by design; the embedded image is what matters there.
6. **Edits are branches.** "Make the labels bigger" is a child ask. The agent
   calls `generate_image` with `edit_of: <asset name>`; the host resumes the
   Codex thread recorded in the extension, so invariants are preserved.
7. **The host owns Codex isolation.** A private `CODEX_HOME` under
   `RABBITHOLE_DIR` (`codex-image-home`) with the user's `auth.json`
   symlinked, MCP servers off, image generation on. The executable is pinned
   once via `resolveExecutable("codex", env.RABBITHOLE_CODEX_BIN)`; that
   override is also the test seam.
8. **Failures are typed and stay in prose.** Codex missing, signed out, image
   quota exhausted (with reset time), timeout, and generation failure return
   as a JSON `{status:"error"}` tool result, not an MCP error, so the agent
   can tell the learner plainly and still finish the text answer.

## 3. Tool contract

```
generate_image {
  session_id: string        // as answer_branch
  request_id: string        // must map to a pending (unanswered) node
  prompt:     string        // ≤ 4000 chars; the agent's full art direction, verbatim
  aspect?:    "square" | "landscape" | "portrait"     // default: model's choice
  caption?:   string        // ≤ 140 chars; becomes the alt text. Default: first sentence of prompt
  edit_of?:   string        // asset name of an image generated earlier in this hole;
                            // prompt then describes the change ("change only X; keep Y")
  reference?: string        // an asset name in this hole (pasted image, PDF figure crop,
                            // generated image) OR an image_path the host issued to this
                            // session (PDF region crop). Attached as an input image.
}
```

Result content (success):

```
[ { type: "text",  text: JSON { status:"ok", asset:"gen-k3v9x2ab.png",
                                markdown:"![caption](asset:gen-k3v9x2ab.png)",
                                revised_prompt, width, height, elapsed_ms } },
  { type: "image", data:<base64 png>, mimeType:"image/png" } ]
```

Result content (failure): one text block,
`{ status:"error", code, message, resets_at? }` with `code` ∈
`codex_missing | codex_signed_out | image_quota | timeout | generation_failed |
request_not_pending | session_closed | bad_reference`.

Validation: `edit_of` must exist in `extensions.generated_images` of a node in
this hole; `reference` must be an existing asset name or a path the session
issued (session-crops registry); `edit_of` and `reference` are mutually
exclusive in v1. Names are minted as `gen-` + 8 lowercase alphanumerics and
stored with `defaultFsStore.putAsset` (atomic, never overwrites), then added
to `session.assetNames`. A generated asset that the agent never references is
collected by the existing GC at the next node deletion; that is fine.

`src/node/mcp/main.js` gains the ability for a tool to return explicit MCP
`content`; every other tool keeps today's compact-JSON text wrapping.

## 4. The materializer (host side)

New module `src/node/mcp/image-gen.js`; `answer.js` stays about node lifecycle.

- Home: reuse the bridge's `prepareCodexHome` + `codexConfigToml` verbatim,
  pointed at `<RABBITHOLE_DIR>/codex-image-home`. The image tool works
  unchanged under that config (read-only sandbox, bundled skills off, no
  shell, MCP off) and is *cheaper* there: ≈26k input tokens per run instead
  of ≈145k, because Codex no longer reads its imagegen skill (§11).
- Generate: spawn `codex exec --skip-git-repo-check --json
  -c 'mcp_servers={}' -C <scratch dir> -` with `CODEX_HOME` set and the
  prompt on stdin (never as an argument: `-i` is variadic and swallows a
  positional prompt). The stdin text wraps the agent's prompt:
  "Use your built-in image generation tool to generate exactly one image.
  <prompt> <aspect line> Do not run shell commands or copy files. When the
  image exists, reply with the single word DONE."
- Edit: `codex exec resume <thread_id> -` with the same environment.
  Reference: add `-i <path>` before `-`.
- Output: read `thread_id` from the first `thread.started` JSON event; on exit
  take the newest `<CODEX_HOME>/generated_images/<thread_id>/*.png`. None →
  `generation_failed` carrying the agent's last message. `turn.failed` whose
  message mentions usage limits → `image_quota` (parse a reset time when
  present).
- Deadline 180 s (observed 72–95 s). Abort on `extra.signal` or deadline via
  `terminateChild` (SIGTERM, SIGKILL after 1 s). One generation per session
  at a time; a second call waits.
- Broadcast `node_work_state: "drawing"` for the request's node before
  spawning; restore the prior state in `finally`.
- Upgrade path, not v1: drive `codex app-server` (the bridge's
  `CodexAppServer`) and consume the typed `imageGeneration` thread item
  (`savedPath`, `revisedPrompt`, `usageLimitExceeded{resetsAt}`) instead of
  globbing. Same module boundary, no contract change.

## 5. Card states and rendering

- `apply-server-event.js` keeps `drawing` as a distinct work state (today
  anything but `queued`/`delegated` collapses to thinking).
- `buildLoading` shows the bunny with "Drawing…"; when prose has already
  streamed, `fillStreaming` appends a quiet "Drawing…" line beneath the text.
  Copy is exactly "Drawing…".
- The image renders through the existing markdown image path. Lightbox
  (`src/ui/image-ux.js`) shows the caption and, when
  `extensions.generated_images[name]` exists on the node, a second line with
  the revised prompt. That is how the learner sees what was asked for.
- Deferred, not v1: dark-mode matting for white-background rasters;
  click-select a raster to open the ask composer with `attachment_assets`.
  In v1 an edit is a follow-up ask on the card; the agent already has the
  asset name from lineage markdown.

## 6. Model-facing guidance

Add to `AUTHORING_VOCABULARY_V1` (`src/core/prompts/authoring-v1.js`), scoped
"when a `generate_image` tool is available":

> When the learner asks you to draw, illustrate, sketch, or show a picture,
> make one with `generate_image`. Stream your prose first
> (`answer_branch` partial), then call the tool, then send the final chunk
> with the returned markdown line where the picture belongs. Look at the
> result; if a label or fact is wrong, call again with `edit_of` and describe
> only the change. Write the prompt as art direction: subject, style,
> composition, exact text in quotes, what to avoid. Prefer clear educational
> styles; keep text in the image minimal and verbatim. Do not draw unless
> asked.

The tool description in `src/node/mcp/tools.js` carries the parameter
semantics. Budget: `test/contracts/mcp-copy.test.mjs` caps combined
descriptions at 5,000 chars with 966 free; raise the ceiling to 6,000 in the
same change and record why.

## 7. What does not change

- `answer_branch`, `branch_request`, node schema, wire projection, GC rules,
  export formats, the composer, presets, lenses, the ⋯ menu.
- The web BYOK path: `generate_image` is MCP-host only in v1. Web guidance
  must not mention it. The later bridge shape is known: allow the image tool
  in the bridge's Codex home, relay the `imageGeneration` item, store bytes in
  IndexedDB.

## 8. Edge cases

- Agent calls the tool without streaming prose first: works, the card shows
  "Drawing…" from a blank state.
- Agent references an asset it never generated (hallucinated name): the
  markdown renders a broken image; nothing to guard beyond the existing
  `asset:` handling. Guidance says use the returned `markdown` verbatim.
- Session closes mid-generation: kill the child, discard output, return
  `session_closed`.
- Codex upgrade needed (older CLI refuses the configured model): surfaces as
  `generation_failed` with the CLI's message; not a Rabbithole concern.
- Two generations for one node: both land, both referenced, both recorded.

## 9. Tests

- Contracts (`test/contracts/`): schema and validation of every parameter and
  error code; name minting satisfies `validateImageAssetName`; extension
  patch merges (namespace replace semantics: read, merge, write); `drawing`
  survives `applyServerEvent`; copy budgets; `main.js` passes explicit
  content through for this tool only.
- Integration (`test/integration/`): `fixtures/fake-codex-image.mjs`
  selected through `RABBITHOLE_CODEX_BIN`, speaking `codex exec --json`
  (emits `thread.started`, writes a tiny PNG to
  `$CODEX_HOME/generated_images/<thread>/`, supports `resume`, `-i`,
  a signed-out mode, a usage-limit mode, and a hang mode for the deadline).
  Assert: asset stored, `assetNames` updated, extension written, `drawing`
  then restored state broadcast, stdin carried the prompt, `-i` used for
  references, timeout kills the child.
- E2E (`test/e2e/cross-host-journey`): one stdio-client call asserting the
  result has a text block and an image block.
- Live (`check:imagegen-live`, never in `npm test`): one real generation and
  one real `edit_of` on this machine; asserts a PNG lands and the thread id
  resumes. Spends real quota.

## 10. Acceptance checklist

1. In a real hole, "draw me the water cycle" from Claude Code and from Codex
   produces a card with prose, then "Drawing…", then an inline picture; the
   two agents' transcripts show identical tool usage.
2. "Make the labels larger" as a follow-up yields a child card whose image is
   the same composition with larger labels (thread resumed).
3. Box-select a figure in a native PDF and ask "redraw this cleanly":
   `reference` carries the crop; the result is a redraw of that figure.
4. Kill `codex login` state: the card finishes with prose that says Codex is
   signed out; no hung card, no orphan process.
5. Portable export and re-import keep the image and its provenance; frozen
   snapshot keeps the image.
6. `npm test` is green without Codex installed; `check:imagegen-live` is
   green on this machine.

## 11. Verified mechanics (2026-09-07, codex-cli 0.153.4)

- `image_generation` is a stable, enabled feature; the tool is built in and
  needs no `OPENAI_API_KEY`. Codex reads its bundled `imagegen` skill and
  expands the ask into a detailed prompt, recorded as `revisedPrompt`.
- Output: `$CODEX_HOME/generated_images/<thread_id>/<item>.png`,
  ~1250–1700 px, 1–1.6 MB. Works under a private `CODEX_HOME` with a
  symlinked `auth.json`.
- Wall time 72–95 s per image (≈53 s inside the tool). ≈145k input tokens per
  run, mostly cached. Image generation has its own usage-limit bucket.
- `codex exec --json` does not surface the image item; the app-server
  protocol does (`imageGeneration` with `savedPath`).
- `-i <file>` attaches an edit target or reference; `codex exec resume
  <thread>` edits the prior image with invariants preserved (recolor-only
  edit was pixel-stable elsewhere).
- Under the bridge's exact restrictive config (`sandbox_mode = "read-only"`,
  bundled skills disabled, MCP off, `mcp_servers={}`): a labelled leaf
  cross-section generated in 70 s, PNG landed in the private
  `generated_images/<thread>/`, no shell commands were run, and input tokens
  fell to 25.8k (11.5k cached). This is the v1 configuration.
