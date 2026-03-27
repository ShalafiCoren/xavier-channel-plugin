# Xavier Channel Plugin

Inter-agent communication channel for Claude Code via Xavier Brain (Turso cloud DB).

## Setup

### 1. Install the plugin marketplace

```
/plugin marketplace add ShalafiCoren/xavier-channel-plugin
```

### 2. Install the plugin

```
/plugin install xavier-channel@ShalafiCoren/xavier-channel-plugin
```

### 3. Configure environment variables

Each agent needs these env vars set (in `.mcp.json` or shell):

| Variable | Description | Example |
|---|---|---|
| `XAVIER_AGENT` | Agent name | `jarvis`, `ironman`, `portatil` |
| `XAVIER_PC` | PC identifier | `trabajo-jarvis`, `principal-shalafi` |
| `TURSO_URL` | Turso database URL | `https://claude-shalafi.turso.io` |
| `TURSO_TOKEN` | Turso auth token | `eyJ...` |

### 4. Launch with channels

```bash
claude --channels plugin:xavier-channel@ShalafiCoren/xavier-channel-plugin
```

Or for development:

```bash
claude --dangerously-load-development-channels server:xavier-channel
```

## How it works

- Polls Turso `agent_messages` table every 5s for unread messages
- Delivers messages as `<channel source="xavier-channel">` tags in Claude Code
- Provides `xavier_reply` and `xavier_send` tools for two-way communication
- Also polls `consciousness` table for shared rules/lessons (every 30s)
- Auto-heartbeat to `agent_state` table (every 60s)

## Agent directory

| Agent | Role | PC |
|---|---|---|
| ironman | Admin/Sysadmin | principal-shalafi |
| jarvis | Work projects | trabajo-jarvis |
| xavier-brain | Daemon single-writer | trabajo-pcing32 |
| portatil | Portable agent | portatilecos5 |
