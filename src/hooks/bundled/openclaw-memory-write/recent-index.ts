/**
 * `_recent.md` index updates for openclaw-memory-write.
 *
 * Appends a compact entry to the Daily Index section of
 * `~/Simon/Gaeyang/.memory/episodes/_recent.md` so a newly written episode
 * file is automatically visible via the minky broker's `load_working_set`
 * (that file is a PINNED working-set item, per `broker/src/working_set.rs`)
 * at the start of the next OpenClaw session.
 *
 * Node's `fs.appendFile` performs a separate open/write/close sequence and
 * is NOT atomic for concurrent writers beyond PIPE_BUF, so integrity here
 * comes from the in-process write queue below, not from append atomicity.
 */

import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { createSubsystemLogger } from "../../../logging/subsystem.js";

const log = createSubsystemLogger("hooks/openclaw-memory-write/recent-index");

const DAILY_INDEX_HEADING = "## Daily Index";
const STILL_OPEN_HEADING = "## Still Open";
const MAX_ENTRY_CHARS = 200;

export function resolveRecentIndexPath(): string {
  // Override exists for tests only, consistent with the OPENCLAW_STATE_DIR
  // convention -- production always uses the real Gaeyang path.
  const override = process.env.OPENCLAW_MEMORY_WRITE_RECENT_INDEX_PATH?.trim();
  if (override) {
    return override;
  }
  return path.join(os.homedir(), "Simon", "Gaeyang", ".memory", "episodes", "_recent.md");
}

function truncateSummary(summary: string, maxChars: number): string {
  if (summary.length <= maxChars) {
    return summary;
  }
  return `${summary.slice(0, maxChars - 1)}…`;
}

function buildEntryLine(params: {
  dateStr: string;
  channelLabel: string;
  summary: string;
  relativeEpisodePath: string;
}): string {
  const line = `- **${params.dateStr} (${params.channelLabel})** — ${params.summary}. → \`${params.relativeEpisodePath}\``;
  return truncateSummary(line, MAX_ENTRY_CHARS);
}

/**
 * Inserts `line` at the end of the `## Daily Index` section (immediately
 * before `## Still Open`), creating the Daily Index section if the file
 * doesn't have one yet. Returns the resulting file content.
 */
function insertIntoDailyIndex(content: string, line: string): string {
  const stillOpenIdx = content.indexOf(STILL_OPEN_HEADING);
  if (stillOpenIdx === -1) {
    // No Still Open section either: append a Daily Index section (or a new
    // entry under an existing one with no trailing section) at file end.
    if (content.includes(DAILY_INDEX_HEADING)) {
      return `${content.trimEnd()}\n${line}\n`;
    }
    const separator = content.trim().length > 0 ? "\n\n" : "";
    return `${content.trimEnd()}${separator}${DAILY_INDEX_HEADING}\n\n${line}\n`;
  }
  if (!content.includes(DAILY_INDEX_HEADING)) {
    // Still Open exists but Daily Index doesn't: insert both, just before
    // Still Open.
    const before = content.slice(0, stillOpenIdx);
    const after = content.slice(stillOpenIdx);
    return `${before.trimEnd()}\n\n${DAILY_INDEX_HEADING}\n\n${line}\n\n${after}`;
  }
  const before = content.slice(0, stillOpenIdx);
  const after = content.slice(stillOpenIdx);
  return `${before.trimEnd()}\n${line}\n${after}`;
}

// Module-level write queue: serializes all _recent.md writes issued by
// this hook so concurrent shutdown-triggered flushes across sessions
// cannot interleave or clobber each other. See doc comment above re:
// fs.appendFile non-atomicity.
let recentIndexChain: Promise<unknown> = Promise.resolve();

function enqueueRecentIndexOp<T>(op: () => Promise<T>): Promise<T> {
  const result = recentIndexChain.then(op, op);
  recentIndexChain = result.catch(() => undefined);
  return result;
}

/** Appends one compact Daily Index entry for a newly written episode file. */
export function appendToRecentIndex(params: {
  dateStr: string;
  channelLabel: string;
  summary: string;
  relativeEpisodePath: string;
}): Promise<void> {
  return enqueueRecentIndexOp(async () => {
    const filePath = resolveRecentIndexPath();
    const line = buildEntryLine(params);
    let content: string;
    try {
      content = await fs.readFile(filePath, "utf-8");
    } catch (err) {
      if ((err as { code?: string }).code === "ENOENT") {
        content = "";
      } else {
        log.warn("_recent.md read failed, aborting index update", { error: String(err) });
        throw err;
      }
    }
    const updated = insertIntoDailyIndex(content, line);
    await fs.mkdir(path.dirname(filePath), { recursive: true });
    await fs.writeFile(filePath, updated, "utf-8");
  });
}

/** Test-only: reset the in-process op chain so tests can await a clean state. */
export function resetRecentIndexChainForTest(): void {
  recentIndexChain = Promise.resolve();
}
