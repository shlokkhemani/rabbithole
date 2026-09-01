import { RabbitholeSession } from "./hole-session/session.js";
import { getAgentContextMonitor } from "../context-gauge/index.js";
import { shortId } from "../shared/ids.js";

const sessions = new Map();

export async function createSession(config) {
  let unsubscribeContext = () => {};
  const session = new RabbitholeSession({
    ...config,
    sessionId: mintSessionId(),
    onContextClose: () => unsubscribeContext(),
    onClose: (s) => sessions.delete(s.id),
  });
  sessions.set(session.id, session);
  // Headless mode is used by the hermetic suite and has no browser indicator
  // to update. In normal MCP use, every live session observes one process-level
  // monitor; the last unsubscribe stops its watcher and stat poll.
  if (!process.env.RABBITHOLE_NO_BROWSER) {
    unsubscribeContext = getAgentContextMonitor().subscribe(
      (usage) => session.setContextUsage(usage),
      { sessionId: session.id }
    );
  }
  try { await session.start(); }
  catch (error) {
    unsubscribeContext();
    sessions.delete(session.id);
    throw error;
  }
  return session;
}

function mintSessionId() {
  while (true) {
    const id = shortId();
    if (!sessions.has(id)) return id;
  }
}

export function getSession(sessionId) {
  return sessions.get(sessionId) || null;
}

export function getSessionByHole(holeId) {
  for (const session of sessions.values()) {
    if (session.holeId === holeId && !session.isClosed()) return session;
  }
  return null;
}

/**
 * Close any live session for the same hole (e.g. before a resume opens a new
 * one) so a stale tab shows "reopened elsewhere" instead of shimmering forever.
 */
export function closeSessionsForHole(holeId, reason = "superseded") {
  for (const session of [...sessions.values()]) {
    if (session.holeId === holeId && !session.isClosed()) session.close(reason);
  }
}

/**
 * Close every live session (broadcasting the reason to the browsers so they
 * show a "session ended" state) and wait for pending saves — call before the
 * process exits.
 */
export async function closeAllSessions(reason = "agent_exited") {
  const live = [...sessions.values()];
  const saves = [];
  for (const session of live) {
    try {
      saves.push(session.close(reason));
    } catch {}
  }
  await Promise.allSettled(saves);
}
