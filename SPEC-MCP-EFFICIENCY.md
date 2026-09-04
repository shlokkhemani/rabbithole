# Spec: Rabbithole MCP efficiency — seven sequential changes

Status: ready for implementation, one step at a time, in order. Each step is
independently shippable: tests green, dist rebuilt, deployable. Decisions were
made on the canvas "Rabbithole MCP efficiency audit" (hole `2a2325ff`) on
2026-09-01/02 and are recorded here so the implementer needs nothing else.

## 0. Baselines (measured 2026-09-01)

Source: 30 Claude Code transcripts in
`~/.claude/projects/-Users-shlokkhemani-Projects-lifestream`, 22 with Rabbithole
activity, Aug 12 – Sep 1. Re-measure after each step with
`python3 scripts/audit-mcp-transcripts.py <transcript-dir>` (see §8).

| Metric | Baseline |
|---|---|
| MCP calls / asks answered | 1,836 / 597 |
| Rabbithole share of all billed context tokens | 10.5% (295M of 2.81B) |
| Notes transmitted / unique / repeats | 2,635 / 446 / 83% |
| Notes share of Rabbithole footprint | 22.1% (≈18% is repeats) |
| `list_rabbitholes` calls / total chars / median | 14 / 536K / 41K |
| Rehydration payloads / chars / max | 10 / 220K / 43.8K; 2 asks dropped at 76K–78K |
| Asks whose parent the agent may not hold | 7% (3% never delivered, 4% pre-compaction) |
| Failed calls from mistyped UUIDs | 14 (0.8% of calls) |
| Asks already queued when the previous answer finished | 41 of 477 (9%) |
| Sessions closed by the 2h idle timeout | 11 |
| Long listener waits (>30 min) after the Aug 18 keepalive: survived / aborted | 20 / 7 |
| Server instructions delivered to the model | first 2,076 chars of 7,424 (host truncates) |

Facts the implementer must know:

- Claude Code backgrounds any MCP call after 120s and delivers the result
  later as a `<task-notification>` user message. The blocking listener is
  designed for this; it is the push channel. Do not "fix" it.
- Claude Code truncates a server's `instructions` at ≈2,000 chars. Anything
  past that reaches the model only through tool descriptions.
- MCP tool input is not streamed. The card shows nothing until a call lands.

Step 6 outcome (2026-09-02): an `open_rabbithole {hole_id}` listener backgrounded by
Claude Code at 01:03 IST was still pending at 02:12 IST with the canvas idle
(>69 min, well past the 2,983s aborts seen on Aug 30). The 4-minute progress
keepalive holds under the current Claude Code build; no Rabbithole change and
no bug report needed. Kill-server check (SIGTERM to the MCP server with that
listener backgrounded and the canvas open): within 8s the canvas showed the
"The agent has left — everything answered so far is saved" banner, and Claude Code
reported the backgrounded call as failed with "Connection closed". No eternal
spinner; no change needed.

## 1. Structural principles (normative)

1. **The server sends what it knows the agent lacks; the agent fetches what
   only it knows it lacks.** Never send context on the guess that the agent
   forgot; never withhold context the server can prove the agent never got.
2. **Bounded payloads.** No branch_request, resume, or list result may exceed
   ~8K chars by construction, independent of canvas size. A cap is not
   truncation; it is a design that cannot grow.
3. **Minimal prompt surface.** Instructions say what to do and where. Nothing
   implied by a tool's name, parameter names, or the response shape is
   repeated. Every rule appears exactly once, in the place the agent reads
   when it needs it.
4. **No agent-side work for UI truthfulness.** Card states derive from server
   state the server already has.
5. **Legacy holes keep opening.** Persisted UUIDs, old note shapes, and
   already-saved rehydration-era files load unchanged.

## 2. Step 1 — Remove the idle timeout

Ruling: yes.

- Delete `SESSION_TIMEOUT_MS` and the timeout scheduling in
  `src/node/mcp/hole-session/session-base.js`. A session lives until the
  human clicks Done, the hole is superseded by a resume, or the MCP client
  disconnects (`main.js` already closes all sessions on `onclose`, stdin
  end/close, SIGINT/SIGTERM).
- Keep `ANSWER_WATCHDOG_MS` (4 min → `stalled`); it is about a delivered ask,
  not idleness.
- Remove `"timeout"` from close-reason docs and tests.

Acceptance: a session left idle for 3h with a connected client still delivers
the next ask to the blocked listener. Existing close-reason tests pass minus
the timeout case.

## 3. Step 2 — Short ids

Ruling: "Let's just issue shorter IDs." No prefix matching; new ids are short.

- Add `shortId()` to `src/core/utils.js`: 8 lowercase hex chars from
  `crypto.getRandomValues`/`randomBytes(4)`. Isomorphic (web + node).
- Every minter uses it: hole ids and root ids (`open.js`), session and
  request ids (`session-base.js`, `session.js`, `answer.js`, registry),
  node ids minted in the web app (`src/ui/core.js`, `clipboard-image.js`),
  note ids, published-note ids (`publishedNoteId` keeps its hash form but
  truncated to 8 hex after the `agent-note-` prefix is fine).
- Uniqueness: hole ids checked against the store on mint (retry on
  collision); node/note ids checked against the session's node map; request
  ids against the request table. Session ids against the registry.
- Input hygiene on every id parameter: trim, strip surrounding quotes and
  interior whitespace before lookup. Cheap, and it would have saved 4 of the
  14 failures on its own.
- Legacy UUIDs remain valid keys everywhere; no migration.

Acceptance: `list_rabbitholes` shows 8-char ids for new holes; a legacy
36-char hole resumes; a request id with a stray space or quote still answers.

## 4. Step 3 — Bounded `list_rabbitholes`

Ruling: "makes complete sense."

- Input: `{ limit?: number (default 10, max 50), query?: string }`.
  `query` is a case-insensitive substring match on title.
- Output: `{ holes: [...], total: number }` so the agent knows when the list
  was cut. Each entry stays `{ hole_id, title, updated_at, node_count }`.
- `listHoles()` in `fs-store.js` already sorts by `updated_at`; filter and
  slice after the sort.

Acceptance: default call returns ≤10 entries plus `total`; `query: "olivetti"`
finds a hole ranked 40th; a call with `limit: 50` still stays under ~10K chars.

## 5. Step 4 — Context model: map, thread, delta notes, `read_rabbithole`

Replaces both the repeated-notes model (`collectRelevantNotes` sending every
ambient note every time) and full-tree rehydration. Decisions from the
"Context model: every angle" node: map includes node status; `thread_of`
returns notes along the thread; ship without a TTL re-send and measure.

### 5.1 Every branch_request carries `map`

```json
"map": {
  "nodes": [ { "id": "a1b2c3d4", "parent": null, "title": "…", "status": "answered" }, … ],
  "notes": [ { "id": "…", "on": "a1b2c3d4", "preview": "first 60 chars", "new": true }, … ]
}
```

- `status` ∈ `answered | pending | note`. Docked notes and reactions appear
  in `notes`, not `nodes`.
- `new` is true when the note was created or edited since this session last
  delivered it (content hash per note id, per session).
- Ordering: nodes in tree order (depth-first), notes standalone-first then by
  `created_at` (reuse `standaloneFirstByAge`).
- Budget: ~40 chars per node; a 50-node hole is ~2K. This is the only
  per-ask context that scales with the tree.

### 5.2 `notes` carries full entries only when needed

- Notes on the lineage of the ask (root → parent): always full, marked
  `on_lineage: true`. Unchanged from today.
- Any other note: full entry only when `new` (never delivered, or edited
  since). Otherwise it appears in `map.notes` only.
- Reaction notes keep resolving to their instruction text
  (`reactionInstructionForNode`) when sent in full.
- `session_closed` uses the same rule: full entries for undelivered notes,
  index for the rest. Today it re-sends everything.

### 5.3 The server auto-sends `thread` when it knows the agent never got it

- The session keeps `delivered: Set<nodeId>` — nodes whose markdown this
  process has sent to or received from the agent: received via
  `answer_branch` (final), sent inside a `thread`, sent by
  `read_rabbithole`, or sent as `content` in `open_rabbithole`.
  Roots opened via `file_path` (markdown or PDF) are **not** delivered: the
  server read the file, the agent may not have.
- On a branch_request whose lineage contains undelivered nodes, the event
  includes `thread: [ { id, title, markdown, notes: [...] } ]` for **only
  those nodes**, in root → parent order, and marks them delivered. Delivered
  ancestors are never re-sent (revised 2026-09-02: the shipped version sent
  the whole lineage and produced 19K and 38K payloads).
- `send_to_rabbithole` on a live session marks its node delivered (the agent
  wrote it). A delegated final does **not**: the listener never saw the
  sub-agent's text, so it rides as `thread` on the next ask on that node.
- Thread budget: `THREAD_BUDGET_CHARS` (24K). Entries are admitted
  nearest-first (parent holds the selection); an entry that does not fit is
  stubbed as `{ id, title, chars, omitted: true }`, is not marked delivered,
  and the agent fetches it with `read_rabbithole { node_ids }` if the ask
  needs it. Notes already inside a sent thread entry are not repeated in
  `notes`.
- `rehydration` is removed. `saved_asks` move to `map` as `pending` nodes
  (they are delivered as ordinary asks anyway).

### 5.4 `read_rabbithole` tool

```
read_rabbithole {
  hole_id: string,
  thread_of?: string,      // node id: lineage root → node, full markdown + notes along it
  node_ids?: string[],     // specific nodes, full markdown
  notes?: boolean          // every note in full
}
```

- No selector → `map` only.
- Works on a live session or straight from disk (like `send_to_rabbithole`).
- Marks returned nodes delivered on the live session.
- Result stays under the host limit by construction only if the agent chooses
  a bounded slice; `node_ids` is capped at 20 per call.

### 5.5 The one rule the agent gets (goes into the Step 7 instructions)

"If the ask refers to a node, note, or ruling whose text you do not hold
verbatim in context, call `read_rabbithole` with `thread_of` before
answering."

Acceptance:
- Same-conversation ask on a fresh hole: no `thread`, `notes` only lineage +
  new, `map` present. Payload for a 30-node hole with 12 notes < 4K chars.
- Cross-conversation resume: first ask carries `thread` for the lineage; no
  `rehydration` key; payload < 8K for the corpus's largest hole (49 nodes).
- A note edited after delivery shows `new: true` and ships in full once.
- `read_rabbithole { thread_of }` on a closed hole returns the thread from
  disk.
- Contract test: for any hole in `test/fixtures`, no server→agent payload
  exceeds 8K chars except `read_rabbithole` results the agent asked for.

## 6. Step 5 — "Waiting for previous answer" card state

Ruling: do it; no agent-side work; the card turns to "Thinking" when the
agent picks the ask up.

- The server already distinguishes queued (`this.queue.push(event)` when no
  waiter) from delivered (`deliverToAgent`). Broadcast that distinction:
  the ask's wire state gains `delivered: boolean` (or a `queued` state on the
  Ask contract; pick whichever keeps `validateAsk` honest and the frozen
  export unchanged).
- Web: pending card label reads "Waiting for previous answer" while
  `delivered` is false, "Thinking" once true, streaming states unchanged.
- Persisted hole JSON unchanged: `queued` is live coordination state, like
  `delegated`, and is not saved.

Acceptance: e2e with two asks fired back to back shows the second card
"Waiting for previous answer" until the first final lands, then "Thinking",
then streaming.

## 7. Step 6 — Keepalive verification

Ruling: "can check." Verification first; code only if it fails.

- In a real Claude Code session, background a listener and kill the MCP
  server process. Confirm the browser card shows an "agent disconnected"
  state (the `setAgentAttached(false, …)` path), not an eternal spinner.
- Then background a listener and leave it >60 min with the canvas idle.
  Confirm the progress notifications keep it alive (`withProgressKeepalive`
  in `tools.js`, 4-min interval). The Aug 30 aborts at 2,983s suggest the
  host may not count progress for backgrounded tasks; if so, this needs a
  Claude Code bug report, not a Rabbithole change, and the disconnected
  state is the mitigation.
- Record the outcome in this file under §0.

## 8. Step 7 — Minimal instructions and tool descriptions

Rulings: instructions minimal at both levels; the agents are smart; guidance
only on what to do and where; nothing implied by names or shapes repeated;
drop the 1–3 sentence streaming rule entirely; the visual-fence rule stays.
This step is last because it describes the final tool surface.

### 8.1 Server `instructions` — the whole thing, under 2,000 chars

```
Rabbithole is an infinite canvas where the human reads a document and
branches: they select text, ask, and your answer becomes a child card.
"Rabbithole" or "rabbit hole" in a request means use this server.

open_rabbithole opens a new document ({title, content} or {file_path}) or
resumes one ({hole_id}; find it with list_rabbitholes). The call blocks
until the human acts and returns a branch_request. Answer it with
answer_branch; your final answer_branch call blocks again as the listener
for the next ask. The pending call is the listener: never poll or re-call
while one is running. The host may move a blocked call to the background
after 120s and deliver its result later as a task notification; that is
normal — end your turn with at most one short line and wait.

A branch_request carries the selection, the question, the lineage of
titles, and a map of the whole canvas. Empty selected_text means a question
about the parent document as a whole. notes are the human's margin notes:
on_lineage ones are the text being replied to; others are context, not
questions. If the ask refers to a node, note, or ruling whose text you do
not hold verbatim in context, call read_rabbithole with thread_of before
answering.

The card shows nothing until a call lands. answer_branch with partial:true
renders at once and returns immediately; chunks concatenate verbatim. Send
any visual fence in one chunk.

Authoring: GFM markdown, $…$ math, tagged code fences, ```mermaid,
```show (HTML/CSS/SVG, theme tokens, ~380px wide), ```check (strict JSON
quiz), and ![alt](asset:name.png) for local images passed as assets.

send_to_rabbithole publishes a document to a saved hole without opening it;
use it only when asked to save or send something there.
```

Keep the count under 2,000 chars after edits. Everything else lives in
the tool that needs it, once.

### 8.2 Tool descriptions

- `open_rabbithole`: one paragraph. New vs resume, `base_url` for fetched
  content, `file_path` for markdown/PDF, `focus` only when the human asks to
  see the canvas, `already_listening` means do not call again,
  `session_closed` carries a reason. PDF page images, `region.image_path`,
  `attachments[].image_path`, `anchor.block`, and `convert_request` are
  described here and nowhere else.
- `answer_branch`: one paragraph plus the authoring vocabulary
  (`AUTHORING_VOCABULARY_V1`, the only copy). `partial`, `title` required on
  final, `delegated` semantics live in the parameter descriptions, not in a
  numbered protocol. Delete `SUB_AGENT_PROTOCOL` as a block; fold its two
  real rules into the `delegated` parameter text ("true after spawning a
  sub-agent, then restore the listener with open_rabbithole {hole_id};
  false to reclaim").
- `read_rabbithole`: two sentences.
- `list_rabbitholes`, `send_to_rabbithole`: as today, shorter.
- Delete `protocol.js` exports that are no longer referenced
  (`STREAMING_RULE`, `LISTENER_RULE`, `RESUME_AND_REHYDRATION`,
  `REGION_AND_ATTACHMENTS`, `CONVERT_RULE`, `SUB_AGENT_PROTOCOL`). Any rule
  that survives has exactly one home.

Acceptance: `instructions.length < 2000`; total tool description chars
< 5,000 (from 11,550); a grep for each surviving rule finds one location;
existing prompt-contract tests updated to the new text.

## 9. Measurement

`scripts/audit-mcp-transcripts.py <dir>` re-runs the audit: merges tool
results with task notifications by task id, and prints the §0 table. Run it
on the lifestream transcripts after each step lands and paste the new row
into §0. The numbers to watch per step: 1 → timeout closes; 2 → id failures;
3 → list chars; 4 → notes repeats, rehydration chars, Rabbithole share of
context; 5 → none (UI); 7 → instruction chars, and the agent's own
chunking behavior now that it is unconstrained.

## 10. Out of scope

- Interleaving queued asks (protocol work; the label in Step 5 is enough for
  now).
- A transient status line on partials ("reading the thread"). Good idea,
  separate spec.
- Changing Claude Code's 120s backgrounding or its instruction truncation.
