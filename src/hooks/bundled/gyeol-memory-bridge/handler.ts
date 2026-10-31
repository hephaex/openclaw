/**
 * gyeol/minky memory bridge hook
 *
 * On every agent bootstrap, spawns the local memory-broker MCP server
 * (~/Simon/minky/broker/target/release/broker-mcp) as a short-lived stdio
 * subprocess, calls its `load_working_set` tool exactly once, and injects
 * the result as an extra virtual bootstrap file (GYEOL_MEMORY.md) so the
 * agent sees the same short-term working set (gyeol) + long-term evidence
 * pointer (minky) that Claude Code and GJC already see via the same
 * broker binary (see ~/Simon/minky/broker/README.md — "vendor neutrality
 * guarantee": whichever client drives the broker, the tools behave
 * identically because it's the same process on stdin/stdout).
 *
 * The broker never becomes a resident daemon here either: it is spawned,
 * asked one question over JSON-RPC, and killed/closed — same
 * "no resident daemon" constraint the broker's own README documents for
 * its other two callers.
 */

import { spawn } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { isAgentBootstrapEvent, type HookHandler } from "../../hooks.js";
import type { WorkspaceBootstrapFile } from "../../../agents/workspace.js";

const DEFAULT_BROKER_BIN = path.join(
  os.homedir(),
  "Simon",
  "minky",
  "broker",
  "target",
  "release",
  "broker-mcp",
);

const CALL_TIMEOUT_MS = 5000;

type JsonRpcResponse = {
  jsonrpc: "2.0";
  id: number;
  result?: { content?: Array<{ type: string; text?: string }> };
  error?: { code: number; message: string };
};

/**
 * Runs one `tools/call` against the broker over a fresh stdio subprocess,
 * following the exact initialize -> notifications/initialized -> tools/call
 * handshake documented in the broker's own README verification recipe.
 * Never throws -- every failure mode (missing binary, timeout, malformed
 * response, minky/gyeol unreachable) resolves to `null` so a broken or
 * absent broker degrades this hook to a silent no-op rather than blocking
 * agent bootstrap.
 */
function callBrokerTool(
  brokerBin: string,
  toolName: string,
  args: Record<string, unknown>,
): Promise<string | null> {
  return new Promise((resolve) => {
    let settled = false;
    const finish = (value: string | null) => {
      if (settled) {
        return;
      }
      settled = true;
      resolve(value);
    };

    let child: ReturnType<typeof spawn>;
    try {
      child = spawn(brokerBin, [], { stdio: ["pipe", "pipe", "ignore"] });
    } catch {
      finish(null);
      return;
    }

    const timer = setTimeout(() => {
      child.kill();
      finish(null);
    }, CALL_TIMEOUT_MS);
    timer.unref?.();

    let buffer = "";
    let stage: "init" | "call" | "done" = "init";

    const send = (msg: Record<string, unknown>) => {
      child.stdin?.write(`${JSON.stringify(msg)}\n`);
    };

    child.on("error", () => {
      clearTimeout(timer);
      finish(null);
    });

    child.stdout?.on("data", (chunk: Buffer) => {
      buffer += chunk.toString("utf-8");
      let newlineIndex: number;
      // eslint-disable-next-line no-cond-assign
      while ((newlineIndex = buffer.indexOf("\n")) !== -1) {
        const line = buffer.slice(0, newlineIndex);
        buffer = buffer.slice(newlineIndex + 1);
        if (!line.trim()) {
          continue;
        }
        let parsed: JsonRpcResponse;
        try {
          parsed = JSON.parse(line) as JsonRpcResponse;
        } catch {
          continue;
        }

        if (stage === "init" && parsed.id === 1) {
          stage = "call";
          send({ jsonrpc: "2.0", method: "notifications/initialized" });
          send({
            jsonrpc: "2.0",
            id: 2,
            method: "tools/call",
            params: { name: toolName, arguments: args },
          });
        } else if (stage === "call" && parsed.id === 2) {
          stage = "done";
          clearTimeout(timer);
          const text = parsed.result?.content?.find((c) => c.type === "text")?.text;
          child.stdin?.end();
          finish(text ?? null);
        }
      }
    });

    send({
      jsonrpc: "2.0",
      id: 1,
      method: "initialize",
      params: {
        protocolVersion: "2024-11-05",
        capabilities: {},
        clientInfo: { name: "openclaw-gyeol-memory-bridge", version: "1" },
      },
    });
  });
}

type WorkingSetMember = {
  rel_path?: string;
  pinned?: boolean;
  in_working_set?: boolean;
};

function formatWorkingSetMarkdown(rawJson: string): string {
  let parsed: unknown;
  try {
    parsed = JSON.parse(rawJson);
  } catch {
    return `# gyeol/minky memory\n\n(load_working_set returned non-JSON output; raw)\n\n\`\`\`\n${rawJson.slice(0, 2000)}\n\`\`\`\n`;
  }

  const members: WorkingSetMember[] = Array.isArray((parsed as { members?: unknown })?.members)
    ? ((parsed as { members: WorkingSetMember[] }).members)
    : [];

  const pinned = members.filter((m) => m.pinned && m.rel_path);
  const inSet = members.filter((m) => m.in_working_set && !m.pinned && m.rel_path);

  const lines: string[] = [
    "# gyeol/minky memory (auto-loaded)",
    "",
    "Short-term working set from the memory-broker (`~/Simon/minky/broker`), the",
    "same broker Claude Code and GJC use. For anything not covered here, call the",
    "`memory-broker` MCP tools directly: `retrieve` (long-term minky evidence),",
    "`record_access` (pull a file into the working set), `load_working_set`",
    "(refresh this snapshot).",
    "",
  ];

  if (pinned.length > 0) {
    lines.push("## Pinned", "");
    for (const m of pinned) {
      lines.push(`- ${m.rel_path}`);
    }
    lines.push("");
  }

  if (inSet.length > 0) {
    lines.push("## Recently active", "");
    for (const m of inSet.slice(0, 20)) {
      lines.push(`- ${m.rel_path}`);
    }
    lines.push("");
  }

  if (pinned.length === 0 && inSet.length === 0) {
    lines.push("(working set is currently empty)", "");
  }

  return lines.join("\n");
}

const bridgeGyeolMemory: HookHandler = async (event) => {
  if (!isAgentBootstrapEvent(event)) {
    return;
  }

  const brokerBin = process.env.GYEOL_MEMORY_BROKER_BIN?.trim() || DEFAULT_BROKER_BIN;

  try {
    fs.accessSync(brokerBin, fs.constants.X_OK);
  } catch {
    // Binary not built yet -- silent no-op, matches the other bundled hooks'
    // fail-open posture (e.g. session-memory falls back to a timestamp slug
    // rather than erroring when its LLM call fails).
    return;
  }

  const rawResult = await callBrokerTool(brokerBin, "load_working_set", {});
  if (!rawResult) {
    return;
  }

  const markdown = formatWorkingSetMarkdown(rawResult);

  // WorkspaceBootstrapFile.name is a closed literal union (AGENTS.md/SOUL.md/
  // etc.) covering the standard on-disk bootstrap files; this is a new
  // *virtual* entry (no file on disk -- content comes straight from the
  // broker call above), so the cast is deliberate rather than a type-safety
  // hole: buildBootstrapContextFiles() only ever consumes `.name` as a
  // display label (`path: file.name` in pi-embedded-helpers/bootstrap.ts),
  // never as a filesystem path, so an unlisted literal is safe downstream.
  const memoryFile = {
    name: "GYEOL_MEMORY.md",
    path: "(virtual: memory-broker load_working_set)",
    content: markdown,
    missing: false,
  } as unknown as WorkspaceBootstrapFile;

  event.context.bootstrapFiles = [...event.context.bootstrapFiles, memoryFile];
};

export default bridgeGyeolMemory;
