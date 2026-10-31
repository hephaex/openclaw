---
name: gyeol-memory-bridge
description: "Load gyeol short-term working set + minky long-term evidence pointer into every agent bootstrap"
homepage: https://docs.openclaw.ai/automation/hooks#gyeol-memory-bridge
metadata:
  {
    "openclaw":
      {
        "emoji": "🧠",
        "events": ["agent:bootstrap"],
        "install": [{ "id": "bundled", "kind": "bundled", "label": "Bundled with OpenClaw" }],
      },
  }
---

# gyeol/minky Memory Bridge Hook

Injects the same short-term memory ("working set") that Claude Code and GJC
already see into every OpenClaw agent bootstrap, via the local
`memory-broker` MCP binary at `~/Simon/minky/broker/target/release/broker-mcp`
(build it with `cargo build --release --bin broker-mcp` from
`~/Simon/minky/broker` if it doesn't exist yet).

## What It Does

On every `agent:bootstrap` event (i.e. every new agent session):

1. Spawns `broker-mcp` as a short-lived stdio subprocess (no resident daemon
   — same lifecycle contract as the broker's other two callers).
2. Runs the MCP `initialize` -> `notifications/initialized` -> `tools/call`
   handshake and calls `load_working_set` once.
3. Formats the result (pinned files + recently-active files from
   `~/Simon/Gaeyang/.memory`, per `broker.toml`'s `[working_set]` config) as
   Markdown.
4. Appends it as a virtual bootstrap file (`GYEOL_MEMORY.md`) alongside
   `AGENTS.md`/`SOUL.md`/etc., so it's part of the agent's normal system
   context — no separate tool call needed to see it.

The injected file also tells the agent how to reach the rest of the broker's
surface directly (register `memory-broker` as an MCP server — see
`~/Simon/minky/broker/README.md` — to get `retrieve` for long-term minky
evidence and `record_access` to pull files into the working set).

## Failure mode

Fully fail-open: if the broker binary is missing, times out (5s), or returns
malformed output, the hook is a silent no-op and bootstrap proceeds with the
standard files only — it never blocks or errors an agent session.

## Configuration

| Env var                    | Default                                                        | Description                                  |
| --------------------------- | --------------------------------------------------------------- | --------------------------------------------- |
| `GYEOL_MEMORY_BROKER_BIN`   | `~/Simon/minky/broker/target/release/broker-mcp`                | Override the broker binary path.              |

## Disabling

```bash
openclaw hooks disable gyeol-memory-bridge
```
