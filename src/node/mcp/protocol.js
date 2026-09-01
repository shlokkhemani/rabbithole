export const LISTENER_RULE = [
  "The pending tool call itself is the single listener. Leave long waits blocked; never poll or periodically re-attach.",
  "Never claim the canvas is open or listening unless open_rabbithole or an ordinary final answer_branch call is actually running.",
  "For an ordinary, never-delegated request: Do not post a host-chat final answer or end the agent turn while the listener should remain active.",
  "already_listening means another live call owns delivery. A host cancellation may resume once with { hole_id }.",
].join(" ");

export const STREAMING_RULE = [
  "Stream answers in 1–3 sentence chunks with partial=true, then send the remaining final chunk with a short title.",
  "Chunks concatenate verbatim: include spacing and newlines and never repeat text already sent.",
  "An ordinary final answer_branch becomes the listener; a retained delegated final returns immediately.",
].join(" ");

export const SUB_AGENT_PROTOCOL = [
  "Sub-agent protocol (branch_request only; never convert_request):",
  "1. Sub-agents never call Rabbithole; the main agent is the sole coordinator.",
  "2. After spawning a sub-agent, call answer_branch with exactly { session_id, request_id, delegated: true }. It returns immediately; the card shows \"Working in sub-agent…\". Pass the question and selected_text to the sub-agent yourself—it cannot fetch them.",
  "3. Immediately restore the sole listener with open_rabbithole { hole_id }. Skip this only while an ordinary final answer_branch is still blocked: that call is the listener; already_listening confirms one is attached.",
  "4. When the sub-agent returns, stream or finish the retained request_id normally, omitting delegated. Partials and the final all return immediately; delegated requests may finish in any order and never take the listener.",
  "5. If the sub-agent fails or is abandoned, call answer_branch with exactly { session_id, request_id, delegated: false } to reclaim it, then answer it yourself. It returns to ordinary Thinking and listener behavior.",
  "Delegation is live coordination state: it survives canvas reload, not server restart.",
].join("\n");

export const CONVERT_RULE = "A convert_request means the human clicked Create text version. Read pages[].image_path in order, follow its inline rules, and stream through answer_branch. The host crops figure: references; never send page images back.";

export const CONTEXT_READING_RULE = "Branch requests include a compact map and automatically include an undelivered lineage as thread. Use read_rabbithole when you need other saved node or note text verbatim.";

export const REGION_AND_ATTACHMENTS = "Read every attachments[].image_path. When region.image_path is present, read it before answering and trust it over extracted text for math, tables, and figures.";
