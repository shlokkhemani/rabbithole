import assert from "node:assert/strict";
import fs from "node:fs/promises";
import path from "node:path";
import test from "node:test";
import { pathToFileURL } from "node:url";
import { selectProfile, setCredential, signIn, signOut } from "../../src/extension/commands/llm-commands.js";
import { createModelRuntimeForProfile } from "../../src/extension/llm/model-runtime.js";
import { readProfileCredential } from "../../src/extension/llm/secret-credential-store.js";
import { DocumentRegistry } from "../../src/extension/document-registry.js";
import { NoraDocument } from "../../src/extension/nora-document.js";
import { withTempDir } from "../support/nora-archive-fixture.mjs";

test("LLM profile commands use SecretStorage, provider-owned OAuth, and ignore ambient Pi credentials", async () => {
  await withTempDir(async (dir) => {
    const originalHome = process.env.HOME;
    const originalAnthropic = process.env.ANTHROPIC_API_KEY;
    process.env.HOME = path.join(dir, "home");
    process.env.ANTHROPIC_API_KEY = "ambient-env-key-that-must-be-ignored";
    await fs.mkdir(path.join(process.env.HOME, ".pi", "agent"), { recursive: true });
    await fs.writeFile(path.join(process.env.HOME, ".pi", "agent", "models.json"), JSON.stringify({ secret: "ambient-model-secret" }));

    try {
      const profiles = [
        { id: "corp-key", label: "Corporate Key", provider: "anthropic", model: "claude-sonnet-4-5" },
        { id: "codex", label: "Codex Subscription", provider: "openai-codex", model: "gpt-5-codex" },
      ];
      const vscode = new FakeVscode(profiles);
      const context = { secrets: new MemorySecrets() };
      const registry = new DocumentRegistry();
      const document = await NoraDocument.open(fileUri(path.join(dir, "auth.nora")), {
        tempRoot: dir,
        title: "Auth",
        now: "2026-07-28T00:00:00.000Z",
        idFactory: () => "auth-doc",
      });
      registry.add(document);
      registry.setActive(document);

      vscode.pickLabels.push("Corporate Key");
      await selectProfile(vscode, registry);
      assert.equal(document.state.selectedProfileId, "corp-key");

      vscode.pickLabels.push("Corporate Key");
      vscode.inputs.push("sk-profile-key");
      await setCredential(vscode, context, registry);
      assert.deepEqual(await readProfileCredential(context.secrets, "corp-key"), { type: "api_key", key: "sk-profile-key" });

      const runtime = await createModelRuntimeForProfile(
        { id: "corp-key", label: "Corporate Key", provider: "anthropic", model: "claude-sonnet-4-5", baseUrl: null, api: null, customModel: null },
        context.secrets,
        { ModelRuntime: FakeModelRuntime },
      );
      assert.equal(FakeModelRuntime.creates.at(-1).modelsPath, null);
      assert.equal(FakeModelRuntime.creates.at(-1).allowModelNetwork, false);
      assert.equal(await runtime.credentialStore.read("anthropic").then((credential) => credential.key), "sk-profile-key");
      assert.equal(JSON.stringify(FakeModelRuntime.creates.at(-1)).includes("ambient"), false);

      vscode.pickLabels.push("Codex Subscription");
      vscode.pickLabels.push("Device code login");
      vscode.inputs.push("manual-auth-code");
      await signIn(vscode, context, registry, { ModelRuntime: FakeModelRuntime });
      const codexCredential = await readProfileCredential(context.secrets, "codex");
      assert.equal(codexCredential.type, "oauth");
      assert.equal(codexCredential.access, "oauth-access-token");
      assert(vscode.opened.some((uri) => String(uri).includes("https://auth.example.test")));
      assert(vscode.infos.some((message) => message.includes("Enter device code")));

      vscode.pickLabels.push("Codex Subscription");
      await signOut(vscode, context, registry);
      assert.equal(await readProfileCredential(context.secrets, "codex"), undefined);

      await document.dispose();
    } finally {
      if (originalHome === undefined) delete process.env.HOME;
      else process.env.HOME = originalHome;
      if (originalAnthropic === undefined) delete process.env.ANTHROPIC_API_KEY;
      else process.env.ANTHROPIC_API_KEY = originalAnthropic;
    }
  });
});

/** @param {string} filePath */
function fileUri(filePath) {
  return {
    scheme: "file",
    fsPath: filePath,
    toString: () => pathToFileURL(filePath).href,
  };
}

class FakeVscode {
  constructor(profiles) {
    this.profiles = profiles;
    this.pickLabels = [];
    this.inputs = [];
    this.infos = [];
    this.errors = [];
    this.opened = [];
    this.ProgressLocation = { Notification: 1 };
    this.Uri = { parse: (value) => ({ toString: () => value }) };
    this.env = {
      openExternal: async (uri) => {
        this.opened.push(uri);
      },
    };
    this.workspace = {
      getConfiguration: () => ({
        get: (key) => key === "nora.llm.profiles" ? this.profiles : undefined,
      }),
    };
    this.window = {
      showQuickPick: async (items) => {
        const label = this.pickLabels.shift();
        return items.find((item) => item.label === label) ?? items[0];
      },
      showInputBox: async () => this.inputs.shift(),
      showInformationMessage: async (message) => {
        this.infos.push(String(message));
        return undefined;
      },
      showErrorMessage: async (message) => {
        this.errors.push(String(message));
        return undefined;
      },
      withProgress: async (options, task) => {
        this.infos.push(String(options.title));
        return task();
      },
    };
  }
}

class MemorySecrets {
  constructor() {
    this.values = new Map();
  }

  async get(key) {
    return this.values.get(key);
  }

  async store(key, value) {
    this.values.set(key, value);
  }

  async delete(key) {
    this.values.delete(key);
  }
}

class FakeModelRuntime {
  static creates = [];

  static async create(options) {
    FakeModelRuntime.creates.push(options);
    return new FakeModelRuntime(options);
  }

  constructor(options) {
    this.options = options;
  }

  registerProvider() {}

  getModel(providerId, modelId) {
    if (providerId === "anthropic" && modelId === "claude-sonnet-4-5") {
      return { provider: providerId, id: modelId, baseUrl: "https://api.anthropic.com/" };
    }
    if (providerId === "openai-codex" && modelId === "gpt-5-codex") {
      return { provider: providerId, id: modelId, baseUrl: "https://chatgpt.com/codex" };
    }
    return undefined;
  }

  async login(providerId, type, interaction) {
    assert.equal(providerId, "openai-codex");
    assert.equal(type, "oauth");
    const method = await interaction.prompt({
      type: "select",
      message: "Select OpenAI Codex login method",
      options: [
        { id: "browser", label: "Browser login" },
        { id: "device", label: "Device code login" },
      ],
    });
    assert.equal(method, "device");
    interaction.notify({ type: "auth_url", url: "https://auth.example.test/start", instructions: "Open browser" });
    interaction.notify({ type: "device_code", userCode: "ABCD-EFGH", verificationUri: "https://auth.example.test/device" });
    interaction.notify({ type: "progress", message: "Waiting for authorization" });
    assert.equal(await interaction.prompt({ type: "manual_code", message: "Paste authorization code" }), "manual-auth-code");
    const credential = {
      type: "oauth",
      access: "oauth-access-token",
      refresh: "oauth-refresh-token",
      expires: 1893456000000,
      accountId: "acct-nora",
    };
    await this.options.credentials.modify(providerId, async () => credential);
    return credential;
  }
}
