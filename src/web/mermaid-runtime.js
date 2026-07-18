let runtimePromise = null;
let sourcePromise = null;

const MERMAID_URL = "/mermaid.js";

export function loadMermaidRuntime() {
  if (globalThis.mermaid) return Promise.resolve(globalThis.mermaid);
  if (!runtimePromise) {
    runtimePromise = new Promise((resolve, reject) => {
      const existing = document.querySelector('script[data-rabbithole-runtime="mermaid"]');
      const script = existing || document.createElement("script");
      const finish = () => {
        if (globalThis.mermaid) resolve(globalThis.mermaid);
        else reject(new Error("Mermaid runtime loaded without exposing its browser API"));
      };
      script.addEventListener("load", finish, { once: true });
      script.addEventListener("error", () => reject(new Error("Unable to load the Mermaid runtime")), { once: true });
      if (!existing) {
        script.src = MERMAID_URL;
        script.async = true;
        script.dataset.rabbitholeRuntime = "mermaid";
        document.head.appendChild(script);
      } else if (globalThis.mermaid) {
        finish();
      }
    }).catch((error) => {
      runtimePromise = null;
      throw error;
    });
  }
  return runtimePromise;
}

export function getMermaidSource() {
  if (!sourcePromise) {
    sourcePromise = fetch(MERMAID_URL, { cache: "no-store" }).then(async (response) => {
      if (!response.ok) throw new Error("Unable to load Mermaid for the offline snapshot");
      return response.text();
    }).catch((error) => {
      sourcePromise = null;
      throw error;
    });
  }
  return sourcePromise;
}
