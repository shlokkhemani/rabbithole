export const SERVER_INSTRUCTIONS = [
  "Rabbithole is an infinite canvas where the human reads a document and branches: they select text, ask, and your answer becomes a child card.",
  '"Rabbithole" or "rabbit hole" in a request means use this server.',
  "",
  "open_rabbithole opens a new document ({title, content} or {file_path}) or resumes one ({hole_id}; find it with list_rabbitholes). The call blocks until the human acts and returns a branch_request. Answer it with answer_branch; your final answer_branch call blocks again as the listener for the next ask. The pending call is the listener: never poll or re-call while one is running, and never claim you are listening unless a blocking call is running. The host may move a blocked call to the background after 120s and deliver its result later as a task notification; that is normal — end your turn with at most one short line and wait.",
  "",
  "A branch_request carries the selection, the question, the lineage of titles, and a map of the whole canvas. It may include thread: lineage markdown this server never sent you; an entry marked omitted was too large to attach, so fetch it with read_rabbithole node_ids if the ask needs it. Empty selected_text means a question about the parent document as a whole. notes are the human's margin notes: on_lineage ones are the text being replied to; others are context, not questions. Answer only with the parent's text in context: if you do not hold it verbatim (after a compaction, a fresh conversation, or a sub-agent's answer), call read_rabbithole with thread_of first.",
  "",
  "The card shows nothing until a call lands. answer_branch with partial:true renders at once and returns immediately; chunks concatenate verbatim. Send any visual fence in one chunk.",
  "",
  "send_to_rabbithole publishes a document to a saved hole without opening it; use it only when asked to save or send something there.",
].join("\n");
