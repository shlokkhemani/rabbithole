export class FakePiSession {
  constructor(events = [], options = {}) {
    this.events = events;
    this.options = options;
    this.listeners = new Set();
    this.promptText = null;
    this.aborted = false;
    this.disposed = false;
    this.release = null;
    this.started = false;
    this.done = new Promise((resolve) => { this.release = resolve; });
  }

  subscribe(listener) {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  }

  async prompt(text) {
    this.promptText = text;
    this.started = true;
    this.emit({ type: "message_end", message: { role: "user", content: text, timestamp: 1 } });
    for (const event of this.events) {
      if (this.aborted) break;
      if (event === "hold") await this.done;
      else this.emit(event);
    }
  }

  async waitForIdle() {}

  async abort() {
    this.aborted = true;
    this.release?.();
  }

  dispose() {
    this.disposed = true;
    this.release?.();
  }

  emit(event) {
    for (const listener of [...this.listeners]) listener(event);
  }
}

export function fakePiSessionFactory(events, sink = {}) {
  return async () => {
    const session = new FakePiSession(events);
    sink.session = session;
    return {
      session,
      sessionManager: { appendMessage() {} },
      customTools: [],
      toolNames: [],
    };
  };
}

export function assistantMessage(content, options = {}) {
  return {
    role: "assistant",
    content: [{ type: "text", text: content }],
    api: "fake",
    provider: "fake",
    model: "fake-model",
    usage: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
    stopReason: options.stopReason || "stop",
    timestamp: options.timestamp || 2,
  };
}

export function assistantUpdate(content) {
  const message = assistantMessage(content);
  return {
    type: "message_update",
    message,
    assistantMessageEvent: { type: "text_delta", contentIndex: 0, delta: content, partial: message },
  };
}

export function assistantEnd(content) {
  return { type: "message_end", message: assistantMessage(content) };
}
