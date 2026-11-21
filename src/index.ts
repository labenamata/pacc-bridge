import os from "node:os";
import fs from "node:fs";
import path from "node:path";
import WebSocket from "ws";
import { Type } from "typebox";
import type {
  ExtensionAPI,
  ExtensionContext
} from "@earendil-works/pi-coding-agent";
import type {
  AgentInfo,
  SessionInfo,
  RemoteCommand,
  RemoteCommandResult
} from "./types.js";
import {
  maskToken,
  normalizeServer,
  resolveConfig,
  updateConfig,
  type ConfigSource,
  type ResolvedConfig
} from "./config.js";

export interface PaccExtensionOptions {
  backendUrl?: string;
  authToken?: string;
  agentName?: string;
}

export default function paccExtension(pi: ExtensionAPI) {
  let config: ResolvedConfig = resolveConfig();

  function getAgentName(cwd?: string): string {
    if (config.agentName) return config.agentName;
    const targetDir = cwd || currentContext?.cwd || process.cwd();
    return path.basename(path.resolve(targetDir)) || `Agent-${os.hostname()}`;
  }

  // Agent identity is derived from the working directory folder (not the PID),
  // so restarts and multiple Pi processes in the same project collapse into ONE agent.
  function getAgentId(cwd?: string): string {
    const targetDir = cwd || process.cwd();
    const folder = path.basename(path.resolve(targetDir)) || "pi-agent";
    return `agent_${folder.replace(/[^a-zA-Z0-9_-]/g, "_")}`;
  }

  const agentId = getAgentId();
  let ws: WebSocket | null = null;
  let heartbeatTimer: NodeJS.Timeout | null = null;
  let reconnectTimer: NodeJS.Timeout | null = null;
  let isConnecting = false;
  let currentContext: ExtensionContext | null = null;
  let currentSessionId = "default";

  function connectionState(): string {
    if (ws && ws.readyState === WebSocket.OPEN) return "connected";
    if (isConnecting || (ws && ws.readyState === WebSocket.CONNECTING)) return "connecting";
    return "disconnected";
  }

  function statusText(): string {
    config = resolveConfig();
    const sourceLabel = (source: ConfigSource): string => {
      switch (source) {
        case "config": return "tersimpan";
        case "env": return "env";
        case "default": return "default";
        default: return "turunan";
      }
    };

    return [
      `PACC server : ${config.server} (${sourceLabel(config.serverSource)})`,
      `WebSocket   : ${config.wsUrl} (${sourceLabel(config.wsUrlSource)})`,
      `Status      : ${connectionState()}`,
      `Agent       : ${agentId} (${getAgentName()})`,
      `Token       : ${maskToken(config.authToken)} (${sourceLabel(config.tokenSource)})`,
      `Config file : ${config.configPath}${config.configExists ? "" : " (belum ada)"}`,
      "",
      "Ubah: /pacc-server <ip[:port]> | /pacc-token <token>"
    ].join("\n");
  }

  function teardownSocket(): void {
    if (reconnectTimer) {
      clearTimeout(reconnectTimer);
      reconnectTimer = null;
    }
    if (heartbeatTimer) {
      clearInterval(heartbeatTimer);
      heartbeatTimer = null;
    }

    const old = ws;
    ws = null;
    isConnecting = false;

    if (old) {
      old.removeAllListeners("open");
      old.removeAllListeners("message");
      old.removeAllListeners("close");
      old.removeAllListeners("error");
      // `terminate()` on a CONNECTING socket emits an error asynchronously;
      // keep a no-op listener so teardown never crashes the Pi process.
      old.on("error", () => {});
      try {
        old.terminate();
      } catch {
        // Socket was already closed.
      }
    }
  }

  const VERBOSE_LOGS = process.env.PACC_VERBOSE === "1" || process.env.PACC_DEBUG === "1";
  let lastStatusLabel: string | null = null;

  function setBridgeStatus(state: "connected" | "connecting" | "disconnected"): void {
    const label =
      state === "connected"
        ? "PACC terhubung"
        : state === "connecting"
          ? "PACC menyambung..."
          : "PACC terputus";

    if (label === lastStatusLabel) return;

    const ui = currentContext?.ui;
    if (!ui?.setStatus) return;

    lastStatusLabel = label;
    try {
      ui.setStatus("pacc", label);
    } catch {
      // Status UI is not available in every mode (for example non-interactive runs).
      lastStatusLabel = null;
    }
  }

  /**
   * Connection retries run every 3 seconds, so logging each failure floods the
   * CLI. Stay silent by default: the footer status shows the connection state
   * and `/pacc-status` reports details on demand. Set PACC_VERBOSE=1 to log
   * every failure while debugging.
   */
  function reportConnectionFailure(detail: string): void {
    setBridgeStatus("disconnected");

    if (VERBOSE_LOGS) {
      console.error(`[PACC Extension] ${detail}`);
    }
  }

  function markConnected(): void {
    setBridgeStatus("connected");
  }

  function reconnectNow(): void {
    teardownSocket();
    setBridgeStatus("connecting");
    connect();
  }

  function sendWS(event: string, data: any) {
    if (ws && ws.readyState === WebSocket.OPEN) {
      try {
        ws.send(JSON.stringify({ event, data, timestamp: new Date().toISOString() }));
      } catch (err) {
        console.error("[PACC Extension] Error sending WS message:", err);
      }
    }
  }

  function startHeartbeat() {
    if (heartbeatTimer) clearInterval(heartbeatTimer);
    heartbeatTimer = setInterval(() => {
      sendWS("agent:heartbeat", { agentId });
    }, 10000);
  }

  function connect() {
    if (isConnecting) return;
    if (ws && (ws.readyState === WebSocket.OPEN || ws.readyState === WebSocket.CONNECTING)) return;

    // Re-read the config on every attempt so `/pacc-server` changes (and direct
    // edits to the config file) take effect without restarting Pi.
    config = resolveConfig();
    isConnecting = true;

    let socket: WebSocket;
    try {
      const target = new URL(config.wsUrl);
      target.searchParams.set("client", "agent");
      target.searchParams.set("agentId", agentId);
      target.searchParams.set("token", config.authToken);
      socket = new WebSocket(target.toString());
      ws = socket;
    } catch (err: any) {
      isConnecting = false;
      reportConnectionFailure(`WebSocket URL tidak valid (${config.wsUrl}): ${err?.message || err}`);
      scheduleReconnect();
      return;
    }

    socket.on("open", () => {
      if (ws !== socket) return;
      isConnecting = false;
      markConnected();

      // Register agent (named after working directory folder)
      const effectiveCwd = currentContext?.cwd || process.cwd();
      const agentInfo: AgentInfo = {
        id: agentId,
        name: getAgentName(effectiveCwd),
        hostname: os.hostname(),
        platform: process.platform,
        version: "1.5.2",
        connectionStatus: "connected",
        status: "idle",
        currentActivity: "Connected and ready",
        currentSessionId,
        workingDirectory: effectiveCwd,
        currentModel: currentContext?.model?.id || "unknown",
        lastHeartbeat: new Date().toISOString(),
        createdAt: new Date().toISOString(),
        updatedAt: new Date().toISOString()
      };
      sendWS("agent:register", agentInfo);

      // Register current session if context exists
      if (currentContext) {
        sendCurrentSessionInfo(currentContext);
      }

      startHeartbeat();
    });

    socket.on("message", async (raw) => {
      if (ws !== socket) return;
      try {
        const message = JSON.parse(raw.toString("utf-8"));
        if (message.event === "command") {
          await handleRemoteCommand(message.data as RemoteCommand);
        }
      } catch (err) {
        console.error("[PACC Extension] Error processing incoming WS message:", err);
      }
    });

    socket.on("close", () => {
      if (ws !== socket) return;
      ws = null;
      isConnecting = false;
      if (heartbeatTimer) {
        clearInterval(heartbeatTimer);
        heartbeatTimer = null;
      }
      setBridgeStatus("disconnected");
      scheduleReconnect();
    });

    socket.on("error", (err) => {
      if (ws !== socket) return;
      isConnecting = false;
      reportConnectionFailure(`WebSocket error (${config.wsUrl}): ${err?.message || err}`);
      // The close event follows and schedules a reconnect. Do not call close()
      // here: closing a CONNECTING socket emits another error.
    });
  }

  function scheduleReconnect() {
    if (reconnectTimer) return;
    reconnectTimer = setTimeout(() => {
      reconnectTimer = null;
      connect();
    }, 3000);
  }


  /** Build message content (text + image parts) from a remote command payload. */
  function buildUserContent(payload: any): string | any[] {
    const text: string = payload?.content || "";
    const rawImages: Array<{ mimeType: string; data: string }> = Array.isArray(payload?.images)
      ? payload.images
      : [];

    const imageParts = rawImages
      .filter((img) => img && img.data && img.mimeType)
      .map((img) => ({
        type: "image" as const,
        data: img.data.replace(/^data:image\/\w+;base64,/, ""),
        mimeType: img.mimeType
      }));

    if (imageParts.length === 0) return text;
    return [{ type: "text" as const, text }, ...imageParts];
  }

  async function handleRemoteCommand(command: RemoteCommand) {
    const result: RemoteCommandResult = {
      commandId: command.commandId,
      success: false
    };

    try {
      switch (command.type) {
        case "prompt": {
          const content = buildUserContent(command.payload);
          if (currentContext && !currentContext.isIdle()) {
            pi.sendUserMessage(content, { deliverAs: "followUp" });
          } else {
            pi.sendUserMessage(content);
          }
          result.success = true;
          break;
        }

        case "steer": {
          const content = buildUserContent(command.payload);
          pi.sendUserMessage(content, { deliverAs: "steer" });
          result.success = true;
          break;
        }

        case "followUp": {
          const content = buildUserContent(command.payload);
          pi.sendUserMessage(content, { deliverAs: "followUp" });
          result.success = true;
          break;
        }

        case "interrupt": {
          if (currentContext) {
            currentContext.abort();
            result.success = true;
          } else {
            result.error = "No active context to interrupt";
          }
          break;
        }

        case "shutdown": {
          if (currentContext) {
            currentContext.shutdown();
            result.success = true;
          }
          break;
        }

        case "set_thinking": {
          const level = command.payload?.level;
          if (level) {
            pi.setThinkingLevel(level);
            result.success = true;
          }
          break;
        }

        default:
          result.error = `Unknown command type: ${command.type}`;
      }
    } catch (err: any) {
      result.error = err.message;
    }

    sendWS("command:result", result);
  }

  function sendCurrentSessionInfo(ctx: ExtensionContext) {
    currentContext = ctx;
    const effectiveCwd = ctx.cwd || process.cwd();
    const effectiveName = getAgentName(effectiveCwd);

    // Update agent name based on actual session directory
    sendWS("agent:register", {
      id: agentId,
      name: effectiveName,
      hostname: os.hostname(),
      platform: process.platform,
      version: "1.5.2",
      connectionStatus: "connected",
      status: ctx.isIdle() ? "idle" : "busy",
      currentActivity: ctx.isIdle() ? "Idle" : "Working",
      currentSessionId,
      workingDirectory: effectiveCwd,
      currentModel: ctx.model?.id || "unknown",
      lastHeartbeat: new Date().toISOString(),
      createdAt: new Date().toISOString(),
      updatedAt: new Date().toISOString()
    });

    const piSessionId = ctx.sessionManager?.getSessionId() || "session_cli";
    currentSessionId = `cli_${piSessionId}`;

    const sessionInfo: SessionInfo = {
      id: currentSessionId,
      agentId,
      piSessionId,
      sessionFile: ctx.sessionManager?.getSessionFile(),
      workingDirectory: ctx.cwd || process.cwd(),
      model: ctx.model?.id || "default",
      thinkingLevel: ctx.thinkingLevel,
      status: ctx.isIdle() ? "idle" : "running",
      mode: "cli_extension",
      currentActivity: ctx.isIdle() ? "Idle" : "Working",
      startedAt: new Date().toISOString(),
      lastActivity: new Date().toISOString(),
      activeToolNames: pi.getActiveTools(),
      stats: {
        inputTokens: 0,
        outputTokens: 0,
        totalTokens: 0,
        toolCallsCount: 0,
        screenshotsCount: 0
      }
    };

    sendWS("session:start", sessionInfo);
  }

  // ----------------------------------------------------
  // EVENT SUBSCRIPTIONS
  // ----------------------------------------------------

  // Session lifecycle
  pi.on("session_start", async (_event, ctx) => {
    currentContext = ctx;
    if (ws && ws.readyState === WebSocket.OPEN) {
      sendCurrentSessionInfo(ctx);
    } else {
      // Deferred: the factory itself must not start background sockets.
      setBridgeStatus("connecting");
      connect();
    }
  });

  pi.on("session_shutdown", async (_event, ctx) => {
    sendWS("session:status", {
      sessionId: currentSessionId,
      status: "disconnected",
      activity: "Session shut down"
    });
    sendWS("agent:status", {
      status: "idle",
      activity: "Session closed"
    });
    teardownSocket();

    try {
      currentContext?.ui?.setStatus?.("pacc", undefined);
    } catch {
      // Status UI is not available in every mode.
    }
    lastStatusLabel = null;
  });

  // Agent execution lifecycle
  pi.on("agent_start", async (_event, ctx) => {
    currentContext = ctx;
    sendWS("agent:status", {
      status: "busy",
      activity: "Agent processing turn"
    });
    sendWS("session:status", {
      sessionId: currentSessionId,
      status: "running",
      activity: "Agent processing turn"
    });
  });

  pi.on("agent_end", async (_event, ctx) => {
    currentContext = ctx;
    sendWS("agent:status", {
      status: "idle",
      activity: "Idle, waiting for input"
    });
    sendWS("session:status", {
      sessionId: currentSessionId,
      status: "idle",
      activity: "Idle"
    });
  });

  pi.on("turn_start", async () => {
    sendWS("session:status", {
      sessionId: currentSessionId,
      status: "running",
      activity: "Starting turn"
    });
  });

  pi.on("turn_end", async () => {
    sendWS("session:status", {
      sessionId: currentSessionId,
      status: "idle",
      activity: "Turn completed"
    });
  });

  // Message streaming
  pi.on("message_update", async (event) => {
    const anyEvent = event as any;
    if (anyEvent.assistantMessageEvent?.type === "text_delta") {
      sendWS("message:delta", {
        sessionId: currentSessionId,
        messageId: anyEvent.message?.id || `msg_${Date.now()}`,
        delta: anyEvent.assistantMessageEvent.delta,
        role: "assistant"
      });
    }
  });

  pi.on("message_end", async (event) => {
    const msg = event.message as any;
    if (msg) {
      let text = "";
      if (typeof msg.content === "string") {
        text = msg.content;
      } else if (Array.isArray(msg.content)) {
        text = msg.content
          .filter((c: any) => c.type === "text")
          .map((c: any) => c.text)
          .join("\n");
      }

      sendWS("message:end", {
        sessionId: currentSessionId,
        messageId: msg.id || `msg_${Date.now()}`,
        role: msg.role || "assistant",
        content: text
      });
    }
  });

  // Tool execution tracking
  pi.on("tool_execution_start", async (event) => {
    sendWS("tool:execution_start", {
      agentId,
      sessionId: currentSessionId,
      toolCallId: event.toolCallId,
      toolName: event.toolName,
      args: event.args
    });
  });

  pi.on("tool_execution_update", async (event) => {
    sendWS("tool:execution_update", {
      sessionId: currentSessionId,
      toolCallId: event.toolCallId,
      partialResult: event.partialResult
    });
  });

  pi.on("tool_execution_end", async (event) => {
    sendWS("tool:execution_end", {
      agentId,
      sessionId: currentSessionId,
      toolCallId: event.toolCallId,
      toolName: event.toolName,
      result: event.result,
      isError: event.isError,
      durationMs: event.durationMs
    });
  });

  // Helper to extract image file path from tool result text (e.g. MCP slim screenshot)
  function extractImagePathFromText(text: string): string | null {
    if (!text || typeof text !== "string") return null;
    const trimmed = text.trim();

    // Check if entire text or a substring looks like an image file path
    // Match common image extensions: .png, .jpg, .jpeg, .webp, .gif
    const imagePathRegex = /(?:[A-Za-z]:[/\\]|[./~]|[/])[^\s"'\n<>*?|]+\.(?:png|jpe?g|webp|gif)/i;
    const match = trimmed.match(imagePathRegex);
    if (!match) return null;

    let candidate = match[0];
    if (candidate.startsWith("~")) {
      candidate = path.join(os.homedir(), candidate.slice(1));
    }
    const cwd = currentContext?.cwd || process.cwd();
    const resolved = path.isAbsolute(candidate) ? candidate : path.resolve(cwd, candidate);

    try {
      if (fs.existsSync(resolved) && fs.statSync(resolved).isFile()) {
        return resolved;
      }
    } catch {
      // Ignore filesystem access errors
    }
    return null;
  }

  function getMimeTypeFromExt(filePath: string): string {
    const ext = path.extname(filePath).toLowerCase();
    switch (ext) {
      case ".jpg":
      case ".jpeg":
        return "image/jpeg";
      case ".webp":
        return "image/webp";
      case ".gif":
        return "image/gif";
      default:
        return "image/png";
    }
  }

  // Provider A: Capture images from tool results (both inline base64 and MCP slim file paths)
  pi.on("tool_result", async (event) => {
    if (event.content && Array.isArray(event.content)) {
      for (const item of event.content) {
        if (item.type === "image" && item.data) {
          sendWS("screenshot:captured", {
            agentId,
            sessionId: currentSessionId,
            source: "agent_image",
            mimeType: item.mimeType || "image/png",
            imageBase64: item.data,
            toolCallId: event.toolCallId
          });
        } else if (item.type === "text" && item.text) {
          // Detect MCP slim mode or tools returning file paths
          const imagePath = extractImagePathFromText(item.text);
          if (imagePath) {
            try {
              const buf = fs.readFileSync(imagePath);
              // Max ~15MB limit before sending
              if (buf.length <= 15 * 1024 * 1024) {
                sendWS("screenshot:captured", {
                  agentId,
                  sessionId: currentSessionId,
                  source: "agent_image",
                  mimeType: getMimeTypeFromExt(imagePath),
                  imageBase64: buf.toString("base64"),
                  toolCallId: event.toolCallId
                });
              }
            } catch (err: any) {
              if (VERBOSE_LOGS) {
                console.error("[PACC Extension] Gagal membaca gambar dari file tool result:", err?.message || err);
              }
            }
          }
        }
      }
    }
  });

  pi.on("model_select", async (event, ctx) => {
    currentContext = ctx;
    sendWS("session:status", {
      sessionId: currentSessionId,
      status: ctx.isIdle() ? "idle" : "running",
      activity: `Model changed to ${event.model?.id}`
    });
  });

  // Provider C: Register custom screenshot tool
  pi.registerTool({
    name: "pacc_screenshot",
    label: "PACC Screenshot",
    description: "Capture and upload a screenshot or image file directly to Pi Agent Command Center (PACC).",
    parameters: Type.Object({
      reason: Type.String({ description: "Why the screenshot is being submitted or captured" }),
      imagePath: Type.Optional(Type.String({ description: "Optional local path to an image file to upload as screenshot" }))
    }),
    execute: async (_toolCallId, params, _signal, _onUpdate, ctx) => {
      try {
        let base64Data: string | undefined;
        let mimeType = "image/png";

        if (params.imagePath) {
          const resolvedPath = path.resolve(ctx.cwd, params.imagePath);
          if (fs.existsSync(resolvedPath)) {
            const buf = fs.readFileSync(resolvedPath);
            base64Data = buf.toString("base64");
            const ext = path.extname(resolvedPath).toLowerCase();
            if (ext === ".jpg" || ext === ".jpeg") mimeType = "image/jpeg";
            else if (ext === ".webp") mimeType = "image/webp";
          } else {
            return {
              content: [{ type: "text", text: `Error: File not found at ${resolvedPath}` }],
              details: { error: "File not found" },
              isError: true
            };
          }
        }

        if (base64Data) {
          sendWS("screenshot:captured", {
            agentId,
            sessionId: currentSessionId,
            source: "custom_tool",
            mimeType,
            imageBase64: base64Data
          });

          return {
            content: [{ type: "text", text: `Successfully captured and uploaded screenshot to PACC (${params.reason})` }],
            details: { success: true, reason: params.reason }
          };
        } else {
          return {
            content: [{ type: "text", text: "Screenshot command noted; no local imagePath was supplied to attach." }],
            details: { status: "noted" }
          };
        }
      } catch (err: any) {
        return {
          content: [{ type: "text", text: `Failed to capture screenshot: ${err.message}` }],
          details: { error: err.message },
          isError: true
        };
      }
    }
  });

  // ----------------------------------------------------
  // COMMANDS: server endpoint configuration
  // ----------------------------------------------------

  pi.registerCommand("pacc-server", {
    description: "Lihat atau ubah alamat server PACC (contoh: /pacc-server 192.168.1.10:4317)",
    handler: async (args, ctx) => {
      const input = (args || "").trim();

      if (!input || input === "show" || input === "status") {
        ctx.ui.notify(statusText(), "info");
        return;
      }

      if (input === "reset" || input === "default") {
        updateConfig({ server: undefined, wsUrl: undefined });
        reconnectNow();
        ctx.ui.notify(`Alamat server PACC di-reset. Aktif: ${resolveConfig().server}`, "info");
        return;
      }

      try {
        const normalized = normalizeServer(input);
        updateConfig({ server: normalized.server, wsUrl: undefined });
        reconnectNow();
        ctx.ui.notify(
          `Server PACC diatur ke ${normalized.server}\nWebSocket: ${normalized.wsUrl}\nMenyambung ulang...`,
          "info"
        );
      } catch (err: any) {
        ctx.ui.notify(`Alamat server tidak valid: ${err?.message || err}`, "error");
      }
    }
  });

  pi.registerCommand("pacc-token", {
    description: "Lihat atau ubah token auth PACC (contoh: /pacc-token rahasia123)",
    handler: async (args, ctx) => {
      const input = (args || "").trim();
      const current = resolveConfig();

      if (!input || input === "show" || input === "status") {
        ctx.ui.notify(
          `Token PACC: ${maskToken(current.authToken)} (${current.tokenSource})\n` +
            "Ubah: /pacc-token <token>\nReset: /pacc-token reset",
          "info"
        );
        return;
      }

      if (input === "reset" || input === "default") {
        updateConfig({ authToken: undefined });
        reconnectNow();
        ctx.ui.notify(`Token PACC di-reset ke nilai ${resolveConfig().tokenSource}.`, "info");
        return;
      }

      updateConfig({ authToken: input });
      reconnectNow();
      ctx.ui.notify(`Token PACC diperbarui (${maskToken(input)}). Menyambung ulang...`, "info");
    }
  });

  pi.registerCommand("pacc-status", {
    description: "Tampilkan status koneksi bridge PACC",
    handler: async (_args, ctx) => {
      ctx.ui.notify(statusText(), "info");
    }
  });
}
