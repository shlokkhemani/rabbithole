import { createVsCodeAuthInteraction } from "../llm/auth-interaction.js";
import { createUncheckedModelRuntimeForProfile } from "../llm/model-runtime.js";
import {
  profileRuntimeProviderId,
  readConfiguredLlmProfiles,
} from "../llm/profile-store.js";
import {
  ProfileCredentialStore,
  storeProfileCredential,
} from "../llm/secret-credential-store.js";

/**
 * @param {import("vscode").ExtensionContext} context
 * @param {import("../document-registry.js").DocumentRegistry} registry
 * @param {{
 *   vscode?: typeof import("vscode"),
 *   ModelRuntime?: { create(options?: Record<string, unknown>): Promise<any> },
 * }} [options]
 */
export function registerLlmCommands(context, registry, options = {}) {
  const vscodeApi = options.vscode;
  if (!vscodeApi) throw new Error("registerLlmCommands requires a VS Code API instance");
  return [
    vscodeApi.commands.registerCommand("nora.selectProfile", () => selectProfile(vscodeApi, registry)),
    vscodeApi.commands.registerCommand("nora.setCredential", () => setCredential(vscodeApi, context, registry)),
    vscodeApi.commands.registerCommand("nora.signIn", () => signIn(vscodeApi, context, registry, options)),
    vscodeApi.commands.registerCommand("nora.signOut", () => signOut(vscodeApi, context, registry)),
  ];
}

/**
 * @param {typeof import("vscode")} vscodeApi
 * @param {import("../document-registry.js").DocumentRegistry} registry
 */
export async function selectProfile(vscodeApi, registry) {
  const document = registry.activeDocument;
  if (!document) {
    await vscodeApi.window.showInformationMessage("Open a Nora document before selecting a profile.");
    return;
  }
  const profile = await pickProfile(vscodeApi, registry, "Select Nora LLM profile");
  if (!profile) return;
  await document.selectProfile(profile.id);
}

/**
 * @param {typeof import("vscode")} vscodeApi
 * @param {import("vscode").ExtensionContext} context
 * @param {import("../document-registry.js").DocumentRegistry} registry
 */
export async function setCredential(vscodeApi, context, registry) {
  const profile = await pickProfile(vscodeApi, registry, "Set Nora LLM credential");
  if (!profile) return;
  const key = await vscodeApi.window.showInputBox({
    title: `Set credential for ${profile.label}`,
    prompt: "Enter the provider API key for this Nora profile.",
    password: true,
    ignoreFocusOut: true,
  });
  if (!key) return;
  await storeProfileCredential(context.secrets, profile.id, { type: "api_key", key });
  await vscodeApi.window.showInformationMessage(`Stored credential for ${profile.label}.`);
}

/**
 * @param {typeof import("vscode")} vscodeApi
 * @param {import("vscode").ExtensionContext} context
 * @param {import("../document-registry.js").DocumentRegistry} registry
 * @param {{ ModelRuntime?: { create(options?: Record<string, unknown>): Promise<any> } }} [options]
 */
export async function signIn(vscodeApi, context, registry, options = {}) {
  const profile = await pickProfile(vscodeApi, registry, "Sign in to Nora LLM profile");
  if (!profile) return;
  try {
    const runtime = await createUncheckedModelRuntimeForProfile(profile, context.secrets, {
      ModelRuntime: options.ModelRuntime,
    });
    await runtime.modelRuntime.login(runtime.runtimeProviderId, "oauth", createVsCodeAuthInteraction(vscodeApi));
    await vscodeApi.window.showInformationMessage(`Signed in to ${profile.label}.`);
  } catch (error) {
    await vscodeApi.window.showErrorMessage(error instanceof Error ? error.message : String(error));
  }
}

/**
 * @param {typeof import("vscode")} vscodeApi
 * @param {import("vscode").ExtensionContext} context
 * @param {import("../document-registry.js").DocumentRegistry} registry
 */
export async function signOut(vscodeApi, context, registry) {
  const profile = await pickProfile(vscodeApi, registry, "Sign out of Nora LLM profile");
  if (!profile) return;
  const store = new ProfileCredentialStore(context.secrets, profile.id, profileRuntimeProviderId(profile));
  await store.delete(profileRuntimeProviderId(profile));
  await vscodeApi.window.showInformationMessage(`Signed out of ${profile.label}.`);
}

/**
 * @param {typeof import("vscode")} vscodeApi
 * @param {import("../document-registry.js").DocumentRegistry} registry
 * @param {string} title
 * @returns {Promise<import("../llm/profile-store.js").NoraLlmProfile | null>}
 */
async function pickProfile(vscodeApi, registry, title) {
  let profiles;
  try {
    profiles = readConfiguredLlmProfiles(vscodeApi);
  } catch (error) {
    await vscodeApi.window.showErrorMessage(error instanceof Error ? error.message : String(error));
    return null;
  }
  if (profiles.length === 0) {
    await vscodeApi.window.showInformationMessage("Configure nora.llm.profiles before using Nora LLM commands.");
    return null;
  }
  const selectedId = registry.activeDocument?.state.selectedProfileId ?? null;
  if (profiles.length === 1) return profiles[0];
  const picked = await vscodeApi.window.showQuickPick(
    profiles.map((profile) => ({
      label: profile.label,
      description: `${profile.provider} / ${profile.model}`,
      detail: profile.baseUrl ?? undefined,
      profile,
      picked: profile.id === selectedId,
    })),
    { title, ignoreFocusOut: true },
  );
  return picked?.profile ?? null;
}
