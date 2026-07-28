/**
 * @typedef {import("./secret-credential-store.js").SecretStorageLike} SecretStorageLike
 * @typedef {{ signal?: AbortSignal, prompt(prompt: Record<string, any>): Promise<string>, notify(event: Record<string, any>): void }} AuthInteraction
 */

/**
 * @param {typeof import("vscode")} vscode
 * @param {{ signal?: AbortSignal }} [options]
 * @returns {AuthInteraction}
 */
export function createVsCodeAuthInteraction(vscode, options = {}) {
  const signal = options.signal;
  return {
    signal,
    prompt: (prompt) => promptWithVsCode(vscode, prompt, signal),
    notify: (event) => notifyWithVsCode(vscode, event),
  };
}

/**
 * @param {typeof import("vscode")} vscode
 * @param {Record<string, any>} prompt
 * @param {AbortSignal | undefined} parentSignal
 */
async function promptWithVsCode(vscode, prompt, parentSignal) {
  const signal = composeSignal(parentSignal, prompt.signal);
  if (signal?.aborted) throw new Error("Authentication cancelled");
  if (prompt.type === "select") {
    const options = /** @type {Array<{ id?: unknown, label?: unknown, description?: unknown }>} */ (
      Array.isArray(prompt.options) ? prompt.options : []
    );
    const items = options.map((option) => ({
      label: String(option.label ?? option.id ?? ""),
      description: option.description ? String(option.description) : undefined,
      id: String(option.id ?? ""),
    }));
    const picked = /** @type {{ id: string } | undefined} */ (await abortable(
      vscode.window.showQuickPick(
        items,
        {
          title: String(prompt.message ?? "Select an option"),
          ignoreFocusOut: true,
        },
      ),
      signal,
    ));
    if (!picked) throw new Error("Authentication cancelled");
    return String(picked.id);
  }
  const value = await abortable(
    vscode.window.showInputBox({
      title: String(prompt.message ?? "Authentication"),
      prompt: String(prompt.message ?? ""),
      placeHolder: prompt.placeholder ? String(prompt.placeholder) : undefined,
      password: prompt.type === "secret",
      ignoreFocusOut: true,
    }),
    signal,
  );
  if (!value) throw new Error("Authentication cancelled");
  return value;
}

/**
 * @param {typeof import("vscode")} vscode
 * @param {Record<string, any>} event
 */
function notifyWithVsCode(vscode, event) {
  if (event.type === "auth_url") {
    const url = String(event.url ?? "");
    if (url) void vscode.env.openExternal(uriFor(vscode, url));
    void vscode.window.showInformationMessage(String(event.instructions || "Complete the browser authorization to finish Nora sign in."));
    return;
  }
  if (event.type === "device_code") {
    const uri = String(event.verificationUri ?? "");
    if (uri) void vscode.env.openExternal(uriFor(vscode, uri));
    void vscode.window.showInformationMessage(`Enter device code ${String(event.userCode ?? "")} to finish Nora sign in.`);
    return;
  }
  if (event.type === "progress") {
    const title = String(event.message ?? "Nora sign in");
    if (vscode.window.withProgress && vscode.ProgressLocation?.Notification != null) {
      void vscode.window.withProgress({ location: vscode.ProgressLocation.Notification, title, cancellable: false }, () => Promise.resolve());
    } else {
      void vscode.window.showInformationMessage(title);
    }
    return;
  }
  if (event.type === "info") {
    const links = Array.isArray(event.links) ? event.links : [];
    const labels = links.map((link, index) => String(link.label || `Open ${index + 1}`));
    void vscode.window.showInformationMessage(String(event.message ?? ""), ...labels).then((picked) => {
      const index = labels.indexOf(String(picked ?? ""));
      const url = index >= 0 ? links[index]?.url : null;
      if (url) void vscode.env.openExternal(uriFor(vscode, String(url)));
    });
  }
}

/**
 * @template T
 * @param {Thenable<T> | Promise<T>} promise
 * @param {AbortSignal | undefined} signal
 * @returns {Promise<T>}
 */
function abortable(promise, signal) {
  if (!signal) return Promise.resolve(promise);
  if (signal.aborted) return Promise.reject(new Error("Authentication cancelled"));
  return Promise.race([
    Promise.resolve(promise),
    new Promise((_, reject) => {
      signal.addEventListener("abort", () => reject(new Error("Authentication cancelled")), { once: true });
    }),
  ]);
}

/** @param {AbortSignal | undefined} first @param {AbortSignal | undefined} second */
function composeSignal(first, second) {
  if (!first) return second;
  if (!second) return first;
  const controller = new AbortController();
  const abort = () => controller.abort();
  if (first.aborted || second.aborted) controller.abort();
  else {
    first.addEventListener("abort", abort, { once: true });
    second.addEventListener("abort", abort, { once: true });
  }
  return controller.signal;
}

/** @param {typeof import("vscode")} vscode @param {string} value */
function uriFor(vscode, value) {
  return /** @type {import("vscode").Uri} */ (vscode.Uri.parse(value));
}
