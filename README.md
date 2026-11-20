# pacc-bridge

Pi CLI extension (Pi package) that connects interactive [`pi`](https://github.com/badlogic/pi-mono) sessions to **Pi Agent Command Center (PACC)** — a self-hosted dashboard for monitoring, chatting with, and steering multiple Pi agents.

The bridge streams session lifecycle events, chat messages, tool executions and screenshots to PACC, and accepts remote prompts, steering, follow-ups and interrupts from the dashboard.

## Install

```bash
# default branch
pi install git:github.com/labenamata/pacc-bridge

# pin a tag or commit
pi install git:github.com/labenamata/pacc-bridge@v1.0.0

# manage
pi list
pi update --extensions
pi remove git:github.com/labenamata/pacc-bridge
```

After installing, start a Pi session (or run `/reload` in a running one). The session shows up in the PACC dashboard.

## Commands

Run these from inside a Pi session:

| Command | Description |
| --- | --- |
| `/pacc-server` or `/pacc-server show` | Show active server, WebSocket URL, connection status, agent id, masked token and config path |
| `/pacc-server 192.168.1.10:4317` | Save a new server address and reconnect immediately |
| `/pacc-server reset` | Drop the saved address and fall back to env/default |
| `/pacc-token <token>` | Set the PACC auth token |
| `/pacc-token reset` | Fall back to `PACC_AUTH_TOKEN` or the default token |
| `/pacc-status` | Connection summary (same as `/pacc-server show`) |

Addresses are normalized automatically:

| Input | Server | WebSocket |
| --- | --- | --- |
| `192.168.1.10` | `http://192.168.1.10:4317` | `ws://192.168.1.10:4317/ws` |
| `192.168.1.10:8080` | `http://192.168.1.10:8080` | `ws://192.168.1.10:8080/ws` |
| `https://pacc.example.com` | `https://pacc.example.com` | `wss://pacc.example.com/ws` |
| `https://pacc.example.com/pacc` | `https://pacc.example.com/pacc` | `wss://pacc.example.com/pacc/ws` |
| `ws://192.168.1.10:4317` | `http://192.168.1.10:4317` | `ws://192.168.1.10:4317/ws` |

## Configuration

Settings set by the slash commands are stored in:

```
~/.pi/agent/pacc-bridge.json
```

Override the location with `PACC_CONFIG_PATH`. The file is written atomically with `0600` permissions because it can contain a token.

Resolution priority: **config file (slash commands) → environment variable → default**.

| Environment variable | Purpose |
| --- | --- |
| `PACC_BACKEND_URL` | PACC server, for example `http://192.168.1.10:4317` |
| `PACC_WS_URL` | Explicit WebSocket endpoint (overrides the one derived from the server) |
| `PACC_AUTH_TOKEN` | Auth token (default: `pacc-secret-token-default`) |
| `PACC_AGENT_NAME` | Override the agent display name (default: current project folder) |
| `PACC_VERBOSE` | `1` to log every WebSocket error while debugging |
| `PACC_DEBUG` | Alias of `PACC_VERBOSE` |

## How it works

- Agent identity is derived from the project folder, not the PID, so restarts and multiple `pi` processes in the same project collapse into one agent card.
- The extension connects on `session_start` and closes its socket on `session_shutdown`; it does not start background resources from the extension factory.
- Heartbeat every 10 seconds; automatic reconnect 3 seconds after a dropped socket.
- When the server is unreachable, the bridge prints nothing and keeps retrying every 3 seconds. The Pi footer shows `PACC menyambung...`, `PACC terhubung` or `PACC terputus`, and `/pacc-status` reports details. Set `PACC_VERBOSE=1` to log every WebSocket error.
- Screenshots are captured from image tool results and from the `pacc_screenshot` tool registered by this extension.

## Requirements

- Pi CLI with extension support (tested against `@earendil-works/pi-coding-agent` 1.5.x)
- Node.js 20+
- A reachable PACC backend (`http://127.0.0.1:4317` by default)

## Development

```bash
npm install
npm run typecheck
pi -e ./src/index.ts
```

## License

MIT
