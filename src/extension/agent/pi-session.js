import {
  SessionManager,
  SettingsManager,
  createAgentSession,
} from "@earendil-works/pi-coding-agent";
import { createCanvasTools } from "./canvas-tools.js";
import { createCodeTools } from "./code-tools.js";
import { createSkillReadTool } from "./skill-tools.js";
import { createMcpToolBundle } from "../mcp/pi-tool.js";
import { replayRecordsToSessionManager } from "./transcript.js";

/**
 * @param {{
 *   document: import("../nora-document.js").NoraDocument,
 *   modelRuntimeBundle: { modelRuntime: any, model: any },
 *   resourceLoader: any,
 *   transcriptRecords?: Record<string, unknown>[],
 *   cwd?: string,
 *   runId?: string,
 *   workspaceFolderPath?: string | null,
 *   vscode?: typeof import("vscode"),
 *   mcpSupervisor?: import("../mcp/supervisor.js").McpSupervisor,
 *   pi?: {
 *     createAgentSession?: typeof createAgentSession,
 *     SessionManager?: typeof SessionManager,
 *     SettingsManager?: typeof SettingsManager,
 *   }
 * }} options
 */
export async function createNoraPiSession(options) {
  const pi = options.pi ?? {};
  const SessionManagerCtor = pi.SessionManager ?? SessionManager;
  const SettingsManagerCtor = pi.SettingsManager ?? SettingsManager;
  const create = pi.createAgentSession ?? createAgentSession;
  const cwd = options.cwd ?? process.cwd();
  const sessionManager = SessionManagerCtor.inMemory(cwd);
  replayRecordsToSessionManager(options.transcriptRecords ?? [], sessionManager);
  const customToolBundle = createNoraCustomToolBundle({
    document: options.document,
    skillBaseDirs: options.resourceLoader.skillBaseDirs ?? [],
    runId: options.runId,
    workspaceFolderPath: options.workspaceFolderPath,
    vscode: options.vscode,
    mcpSupervisor: options.mcpSupervisor,
  });
  const customTools = customToolBundle.tools;
  const toolNames = customTools.map((tool) => tool.name);
  const settingsManager = SettingsManagerCtor.inMemory({
    compaction: { enabled: false },
    retry: { enabled: false, maxRetries: 0 },
    enableInstallTelemetry: false,
    enableAnalytics: false,
    packages: [],
    extensions: [],
    prompts: [],
    themes: [],
    skills: [],
    enableSkillCommands: true,
  }, { projectTrusted: true });
  const { session } = await create(/** @type {any} */ ({
    cwd,
    agentDir: cwd,
    modelRuntime: options.modelRuntimeBundle.modelRuntime,
    model: options.modelRuntimeBundle.model,
    thinkingLevel: "off",
    resourceLoader: options.resourceLoader,
    customTools,
    noTools: "all",
    tools: toolNames,
    sessionManager,
    settingsManager,
  }));
  return { session, sessionManager, customTools, toolNames, dispose: customToolBundle.dispose };
}

/**
 * @param {{
 *   document: import("../nora-document.js").NoraDocument,
 *   skillBaseDirs: string[],
 *   runId?: string,
 *   workspaceFolderPath?: string | null,
 *   vscode?: typeof import("vscode"),
 *   mcpSupervisor?: import("../mcp/supervisor.js").McpSupervisor
 * }} options
 */
export function createNoraCustomTools(options) {
  return createNoraCustomToolBundle(options).tools;
}

/**
 * @param {{
 *   document: import("../nora-document.js").NoraDocument,
 *   skillBaseDirs: string[],
 *   runId?: string,
 *   workspaceFolderPath?: string | null,
 *   vscode?: typeof import("vscode"),
 *   mcpSupervisor?: import("../mcp/supervisor.js").McpSupervisor
 * }} options
 */
export function createNoraCustomToolBundle(options) {
  const mcpBundle = options.mcpSupervisor || options.workspaceFolderPath || options.vscode
    ? createMcpToolBundle({
        document: options.document,
        workspaceFolderPath: options.workspaceFolderPath,
        vscode: options.vscode,
        supervisor: options.mcpSupervisor,
      })
    : { tools: [], dispose: async () => {} };
  return {
    tools: [
      ...createCodeTools({ document: options.document }),
      createSkillReadTool({ roots: options.skillBaseDirs }),
      ...createCanvasTools({ document: options.document, owner: options.runId ? `agent:${options.runId}` : "agent" }),
      ...mcpBundle.tools,
    ],
    dispose: mcpBundle.dispose,
  };
}

/** @param {string} text */
export function estimateNoraTokens(text) {
  return Math.ceil(String(text).length / 4);
}
