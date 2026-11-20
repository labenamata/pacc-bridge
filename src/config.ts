import fs from "node:fs";
import os from "node:os";
import path from "node:path";

export const DEFAULT_SERVER = "http://127.0.0.1:4317";
export const DEFAULT_AUTH_TOKEN = "pacc-secret-token-default";

// Connection retries call resolveConfig() every few seconds. Keep broken config
// warnings from flooding the CLI by logging each distinct problem only once.
const warnedConfigIssues = new Set<string>();

function warnConfigOnce(key: string, message: string): void {
  if (warnedConfigIssues.has(key)) return;
  warnedConfigIssues.add(key);
  console.error(message);
}

/** Persisted bridge settings, stored in ~/.pi/agent/pacc-bridge.json by default. */
export interface BridgeConfig {
  server?: string;
  wsUrl?: string;
  authToken?: string;
  agentName?: string;
}

export type ConfigSource = "config" | "env" | "default" | "derived";

export interface ResolvedConfig {
  server: string;
  wsUrl: string;
  authToken: string;
  agentName?: string;
  serverSource: ConfigSource;
  wsUrlSource: ConfigSource;
  tokenSource: ConfigSource;
  configPath: string;
  configExists: boolean;
}

export interface NormalizedServer {
  server: string;
  wsUrl: string;
}

export function getConfigPath(): string {
  return process.env.PACC_CONFIG_PATH || path.join(os.homedir(), ".pi", "agent", "pacc-bridge.json");
}

function clean(value: unknown): string | undefined {
  if (typeof value !== "string") return undefined;
  const trimmed = value.trim();
  return trimmed.length > 0 ? trimmed : undefined;
}

export function readConfig(): BridgeConfig {
  const file = getConfigPath();
  if (!fs.existsSync(file)) return {};

  try {
    const parsed = JSON.parse(fs.readFileSync(file, "utf-8"));
    if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) return {};
    return {
      server: clean(parsed.server),
      wsUrl: clean(parsed.wsUrl),
      authToken: clean(parsed.authToken),
      agentName: clean(parsed.agentName)
    };
  } catch (err: any) {
    warnConfigOnce(
      `read:${file}:${err?.message || err}`,
      `[PACC Extension] Gagal membaca konfigurasi ${file}: ${err?.message || err}`
    );
    return {};
  }
}

export function writeConfig(config: BridgeConfig): void {
  const file = getConfigPath();
  fs.mkdirSync(path.dirname(file), { recursive: true });

  const payload: BridgeConfig = {};
  if (clean(config.server)) payload.server = clean(config.server);
  if (clean(config.wsUrl)) payload.wsUrl = clean(config.wsUrl);
  if (clean(config.authToken)) payload.authToken = clean(config.authToken);
  if (clean(config.agentName)) payload.agentName = clean(config.agentName);

  const tmp = `${file}.${process.pid}.tmp`;
  fs.writeFileSync(tmp, `${JSON.stringify(payload, null, 2)}\n`, { mode: 0o600 });
  fs.renameSync(tmp, file);

  // Keep token/config private even if the umask was permissive.
  try {
    fs.chmodSync(file, 0o600);
  } catch {
    // Best effort: chmod is not supported on every filesystem.
  }
}

/** Merge a patch into the config file. `undefined` / empty values remove keys. */
export function updateConfig(patch: Partial<BridgeConfig>): BridgeConfig {
  const next: BridgeConfig = { ...readConfig() };
  for (const key of ["server", "wsUrl", "authToken", "agentName"] as const) {
    if (!(key in patch)) continue;
    const value = clean(patch[key]);
    if (value) next[key] = value;
    else delete next[key];
  }
  writeConfig(next);
  return next;
}

/**
 * Accepts a hostname, host:port, URL with a path, or a ws:// URL and returns a
 * normalized HTTP server URL plus the WebSocket endpoint PACC expects.
 *
 * Rules:
 * - The port is only used when written explicitly, except for a bare host with
 *   no scheme, which falls back to the PACC default port 4317.
 * - `https://pacc.example.com` stays `https://pacc.example.com` (implicit 443);
 *   it never becomes `:4317`.
 * - Missing scheme on a bare host is treated as http:// (with :4317).
 * - http(s) URLs get /ws appended to their path.
 */
export function normalizeServer(input: string): NormalizedServer {
  const raw = (input || "").trim();
  if (!raw) throw new Error("Alamat server kosong.");

  const schemeMatch = raw.match(/^([a-z][a-z0-9+.-]*):\/\//i);
  const suppliedScheme = schemeMatch?.[1]?.toLowerCase();
  const body = schemeMatch ? raw.slice(schemeMatch[0].length) : raw;

  if (suppliedScheme && !["http", "https", "ws", "wss"].includes(suppliedScheme)) {
    throw new Error(`Skema "${suppliedScheme}" tidak didukung. Gunakan http://, https://, ws://, atau wss://.`);
  }

  const scheme = suppliedScheme ?? "http";
  const authority = body.split(/[/?#]/, 1)[0] || "";
  const hasPort = authority.startsWith("[")
    ? /^\[[^\]]+\]:\d+$/.test(authority)
    : /:\d+$/.test(authority);

  let url: URL;
  try {
    url = new URL(`${scheme}://${body}`);
  } catch {
    throw new Error(`Alamat tidak valid: "${raw}". Contoh: 192.168.1.10:4317`);
  }

  if (!url.hostname) throw new Error(`Hostname tidak ditemukan pada "${raw}".`);

  // A bare host without scheme (for example `192.168.1.10`) is a shorthand for the
  // default PACC endpoint. When the user writes a scheme or a port, keep exactly that.
  if (!suppliedScheme && !hasPort) {
    url.port = "4317";
  }

  url.search = "";
  url.hash = "";

  if (url.protocol === "ws:" || url.protocol === "wss:") {
    const httpProtocol = url.protocol === "wss:" ? "https:" : "http:";
    let wsPath = url.pathname;
    if (!wsPath || wsPath === "/") wsPath = "/ws";

    const basePath = wsPath.replace(/\/ws\/?$/, "").replace(/\/+$/, "");
    return {
      server: `${httpProtocol}//${url.host}${basePath}`,
      wsUrl: `${url.protocol}//${url.host}${wsPath}`
    };
  }

  const basePath = url.pathname.replace(/\/+$/, "");
  const wsScheme = url.protocol === "https:" ? "wss:" : "ws:";
  return {
    server: `${url.protocol}//${url.host}${basePath}`,
    wsUrl: `${wsScheme}//${url.host}${basePath}${basePath.endsWith("/ws") ? "" : "/ws"}`
  };
}

export function resolveConfig(env: NodeJS.ProcessEnv = process.env): ResolvedConfig {
  const file = readConfig();
  const configPath = getConfigPath();

  const envServer = clean(env.PACC_BACKEND_URL);
  const envWsUrl = clean(env.PACC_WS_URL);
  const envToken = clean(env.PACC_AUTH_TOKEN);
  const envAgentName = clean(env.PACC_AGENT_NAME);

  const fileServer = clean(file.server);
  const fileWsUrl = clean(file.wsUrl);

  let serverSource: ConfigSource;
  let baseServer: string;
  if (fileServer) {
    baseServer = fileServer;
    serverSource = "config";
  } else if (envServer) {
    baseServer = envServer;
    serverSource = "env";
  } else {
    baseServer = DEFAULT_SERVER;
    serverSource = "default";
  }

  const normalized = (() => {
    try {
      return normalizeServer(baseServer);
    } catch (err: any) {
      warnConfigOnce(
        `server:${baseServer}:${err?.message || err}`,
        `[PACC Extension] Konfigurasi server tidak valid (${baseServer}): ${err?.message || err}`
      );
      serverSource = "default";
      return normalizeServer(DEFAULT_SERVER);
    }
  })();

  let wsUrl = normalized.wsUrl;
  let wsUrlSource: ConfigSource = "derived";
  if (fileWsUrl) {
    try {
      wsUrl = normalizeServer(fileWsUrl).wsUrl;
      wsUrlSource = "config";
    } catch (err: any) {
      warnConfigOnce(
        `filews:${fileWsUrl}:${err?.message || err}`,
        `[PACC Extension] PACC_WS_URL tersimpan tidak valid (${fileWsUrl}): ${err?.message || err}`
      );
    }
  } else if (fileServer) {
    wsUrl = normalized.wsUrl;
    wsUrlSource = "derived";
  } else if (envWsUrl) {
    try {
      wsUrl = normalizeServer(envWsUrl).wsUrl;
      wsUrlSource = "env";
    } catch (err: any) {
      warnConfigOnce(
        `envws:${envWsUrl}:${err?.message || err}`,
        `[PACC Extension] PACC_WS_URL tidak valid (${envWsUrl}): ${err?.message || err}`
      );
    }
  }

  const fileToken = clean(file.authToken);
  const tokenSource: ConfigSource = fileToken ? "config" : envToken ? "env" : "default";

  return {
    server: normalized.server,
    wsUrl,
    authToken: fileToken ?? envToken ?? DEFAULT_AUTH_TOKEN,
    agentName: clean(file.agentName) ?? envAgentName,
    serverSource,
    wsUrlSource,
    tokenSource,
    configPath,
    configExists: fs.existsSync(configPath)
  };
}

export function maskToken(token: string): string {
  if (!token) return "(kosong)";
  if (token.length <= 8) return `${token.slice(0, 2)}***`;
  return `${token.slice(0, 4)}…${token.slice(-4)}`;
}
