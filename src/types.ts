/**
 * Local copies of the PACC wire types used by the bridge.
 *
 * The bridge is also distributed as a standalone Pi package (git/npm), so it
 * cannot import type-only definitions from the monorepo workspace package
 * `@pacc/shared`. Keep these in sync with packages/shared/src/index.ts.
 */

export type AgentStatus = "online" | "busy" | "idle" | "disconnected" | "error";
export type AgentConnectionStatus = "connected" | "disconnected";

export interface AgentInfo {
  id: string;
  name: string;
  hostname: string;
  platform: string;
  version: string;
  connectionStatus: AgentConnectionStatus;
  status: AgentStatus;
  currentActivity?: string;
  lastHeartbeat: string;
  createdAt: string;
  updatedAt: string;
  currentSessionId?: string;
  workingDirectory?: string;
  currentModel?: string;
}

export type SessionStatus =
  | "running"
  | "idle"
  | "waiting_input"
  | "error"
  | "disconnected"
  | "historical";

export type SessionOperatingMode = "cli_extension" | "managed_sdk";

export interface SessionStats {
  inputTokens: number;
  outputTokens: number;
  totalTokens: number;
  toolCallsCount: number;
  screenshotsCount: number;
}

export interface SessionInfo {
  id: string;
  agentId: string;
  piSessionId: string;
  sessionFile?: string;
  workingDirectory: string;
  model: string;
  thinkingLevel?: string;
  status: SessionStatus;
  mode: SessionOperatingMode;
  currentActivity?: string;
  startedAt: string;
  lastActivity: string;
  endedAt?: string;
  activeToolNames?: string[];
  stats: SessionStats;
  latestScreenshotThumbnail?: string;
  pinned?: boolean;
}

export type RemoteCommandType =
  | "prompt"
  | "steer"
  | "followUp"
  | "interrupt"
  | "shutdown"
  | "set_model"
  | "set_thinking"
  | "capture_screenshot";

export interface RemoteCommand {
  commandId: string;
  agentId: string;
  sessionId?: string;
  type: RemoteCommandType;
  payload?: any;
  timestamp: string;
}

export interface RemoteCommandResult {
  commandId: string;
  success: boolean;
  error?: string;
  data?: any;
}
