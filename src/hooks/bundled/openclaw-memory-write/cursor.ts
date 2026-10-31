/**
 * Persisted flush-cursor store for openclaw-memory-write.
 *
 * Tracks, per session, the last transcript event id successfully flushed to
 * a gyeol episode record. This is what makes the two independent triggers
 * (`session:auto-reset` and `gateway:shutdown`/`gateway:pre-restart`)
 * idempotent with respect to each other: a session flushed once on
 * shutdown and again later at its next auto-reset must not re-emit the
 * same messages, since episode files are append-only and never rewritten.
 *
 * Deliberately stored OUTSIDE every `sync-memory-to-minky.sh` sync root
 * (`~/Simon/Gaeyang/.memory`, `~/.config/gyeol/memory`,
 * `~/.claude/references`). This is mutable bookkeeping, not a memory
 * record: if it lived inside a sync root it would be uploaded to minky as
 * a junk document and become subject to that script's tombstone-delete
 * sweep, which would violate the append-only guarantee the whole rotation
 * policy (round 13 of the deep-interview) depends on.
 */

import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { resolveStateDir } from "../../../config/paths.js";
import { createSubsystemLogger } from "../../../logging/subsystem.js";

const log = createSubsystemLogger("hooks/openclaw-memory-write/cursor");

const CURSOR_FILE_VERSION = 1 as const;
const CURSOR_PRUNE_MAX_AGE_MS = 30 * 24 * 60 * 60 * 1000; // 30 days

export type FlushTrigger = "auto-reset" | "shutdown" | "pre-restart";

export type FlushCursor = {
  /** Transcript event id of the last message flushed for this session. */
  lastEventId: string;
  /** ISO timestamp of the last successful flush, for diagnostics and pruning. */
  lastFlushedAt: string;
  /** Cumulative owner+assistant messages flushed for this session. */
  messageCount: number;
  lastTrigger: FlushTrigger;
};

type CursorFile = {
  version: typeof CURSOR_FILE_VERSION;
  cursors: Record<string, FlushCursor>;
};

function emptyCursorFile(): CursorFile {
  return { version: CURSOR_FILE_VERSION, cursors: {} };
}

function cursorKey(scope: { storePath: string; sessionId: string }): string {
  return `${scope.storePath}::${scope.sessionId}`;
}

function cursorStorePath(): string {
  return path.join(
    resolveStateDir(process.env, os.homedir),
    "openclaw-memory-write",
    "flush-cursors.json",
  );
}

async function readCursorFile(filePath: string): Promise<CursorFile> {
  let raw: string;
  try {
    raw = await fs.readFile(filePath, "utf-8");
  } catch (err) {
    if ((err as { code?: string }).code === "ENOENT") {
      return emptyCursorFile();
    }
    log.warn("Cursor file read failed, treating as empty", { error: String(err) });
    return emptyCursorFile();
  }
  try {
    const parsed = JSON.parse(raw) as unknown;
    if (
      !parsed ||
      typeof parsed !== "object" ||
      (parsed as { version?: unknown }).version !== CURSOR_FILE_VERSION ||
      typeof (parsed as { cursors?: unknown }).cursors !== "object" ||
      (parsed as { cursors?: unknown }).cursors === null
    ) {
      // Unknown/missing version or malformed shape: treat as corrupt, reset
      // to empty rather than inventing a migration. Same path as a
      // JSON.parse failure -- corruption must never block a flush.
      log.warn("Cursor file has unexpected shape or version, resetting to empty", {
        filePath,
      });
      return emptyCursorFile();
    }
    return parsed as CursorFile;
  } catch (err) {
    log.warn("Cursor file is corrupt JSON, treating as empty", { error: String(err) });
    return emptyCursorFile();
  }
}

function pruneStaleCursors(file: CursorFile, now: number): CursorFile {
  const cutoff = now - CURSOR_PRUNE_MAX_AGE_MS;
  const cursors: Record<string, FlushCursor> = {};
  for (const [key, cursor] of Object.entries(file.cursors)) {
    const flushedAtMs = Date.parse(cursor.lastFlushedAt);
    if (Number.isFinite(flushedAtMs) && flushedAtMs < cutoff) {
      continue;
    }
    cursors[key] = cursor;
  }
  return { version: CURSOR_FILE_VERSION, cursors };
}

async function writeCursorFileAtomic(filePath: string, file: CursorFile): Promise<void> {
  const dir = path.dirname(filePath);
  await fs.mkdir(dir, { recursive: true });
  const tmpPath = path.join(dir, `.flush-cursors.${process.pid}.${Date.now()}.tmp`);
  await fs.writeFile(tmpPath, JSON.stringify(file, null, 2), "utf-8");
  await fs.rename(tmpPath, filePath);
}

// All cursor reads/writes for the whole store run through one module-level
// promise chain. This is the actual dedup-race guard (not any assumption
// about server-close.ts's emit ordering): the entire per-session flush
// (cursor read -> transcript read -> write -> index -> cursor advance) is
// serialized as one critical section by flush.ts, using this chain.
let cursorChain: Promise<unknown> = Promise.resolve();

function enqueueCursorOp<T>(op: () => Promise<T>): Promise<T> {
  const result = cursorChain.then(op, op);
  // Swallow rejection for chain-continuation purposes only; callers still
  // observe the real rejection via the returned promise.
  cursorChain = result.catch(() => undefined);
  return result;
}

/** Reads the persisted cursor for one session, or undefined if none exists. */
export function readCursor(scope: {
  storePath: string;
  sessionId: string;
}): Promise<FlushCursor | undefined> {
  return enqueueCursorOp(async () => {
    const file = await readCursorFile(cursorStorePath());
    return file.cursors[cursorKey(scope)];
  });
}

/**
 * Advances the persisted cursor for one session to `cursor`. Must be
 * called only after the corresponding episode file and `_recent.md` entry
 * have both been durably written (see flush.ts) -- advancing first would
 * risk losing messages if a later step fails; advancing after is at worst
 * a harmless re-flush (at-least-once, deduplicated on success).
 */
export function advanceCursor(
  scope: { storePath: string; sessionId: string },
  cursor: FlushCursor,
): Promise<void> {
  return enqueueCursorOp(async () => {
    const filePath = cursorStorePath();
    const file = await readCursorFile(filePath);
    const pruned = pruneStaleCursors(file, Date.now());
    pruned.cursors[cursorKey(scope)] = cursor;
    await writeCursorFileAtomic(filePath, pruned);
  });
}

/** Test-only: reset the in-process op chain so tests can await a clean state. */
export function resetCursorChainForTest(): void {
  cursorChain = Promise.resolve();
}

export { cursorStorePath as cursorStorePathForTest, cursorKey as cursorKeyForTest };
