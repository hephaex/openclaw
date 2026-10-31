/**
 * Shared per-session flush routine for openclaw-memory-write.
 *
 * Called from both trigger paths in handler.ts (session:auto-reset and
 * gateway:shutdown/gateway:pre-restart). Reads raw transcript events
 * (never the pre-rendered session-memory projection, which loses
 * per-message `senderIsOwner`), filters to owner messages plus their
 * directly-following assistant replies, redacts secrets, writes an
 * append-only episode file, indexes it in `_recent.md`, and advances the
 * persisted flush cursor -- all as one serialized critical section per
 * session, so the two trigger paths cannot interleave for the same
 * session and duplicate or corrupt a flush.
 */

import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { isRecord } from "@openclaw/normalization-core/record-coerce";
import { resolveUserTimezone } from "../../../agents/date-time.js";
import {
  loadTranscriptEventsSync,
  type TranscriptEvent,
} from "../../../config/sessions/session-accessor.js";
import type { OpenClawConfig } from "../../../config/types.openclaw.js";
import { createSubsystemLogger } from "../../../logging/subsystem.js";
import { selectCurrentMemoryWindow } from "../session-memory/capture.js";
import { advanceCursor, readCursor, type FlushCursor, type FlushTrigger } from "./cursor.js";
import { formatEpisodeMarkdown, type EpisodeMessage } from "./format.js";
import { appendToRecentIndex } from "./recent-index.js";

const log = createSubsystemLogger("hooks/openclaw-memory-write/flush");

export type FlushScope = {
  agentId: string;
  sessionId: string;
  sessionKey: string;
  storePath: string;
};

function extractTextContent(content: unknown): string | undefined {
  if (typeof content === "string") {
    return content;
  }
  if (!Array.isArray(content)) {
    return undefined;
  }
  for (const block of content) {
    if (!isRecord(block)) {
      continue;
    }
    if (block.type === "text" && typeof block.text === "string") {
      return block.text;
    }
  }
  return undefined;
}

function eventId(event: TranscriptEvent, index: number): string {
  if (isRecord(event) && typeof event.id === "string" && event.id.trim()) {
    return event.id;
  }
  return `openclaw-memory-write-${index}`;
}

function isOwnerUserMessage(event: TranscriptEvent): boolean {
  if (!isRecord(event) || event.type !== "message" || !isRecord(event.message)) {
    return false;
  }
  const message = event.message;
  if (message.role !== "user") {
    return false;
  }
  const meta = isRecord(message["__openclaw"])
    ? (message["__openclaw"] as Record<string, unknown>)
    : undefined;
  return meta?.senderIsOwner === true;
}

function isNonOwnerUserMessage(event: TranscriptEvent): boolean {
  if (!isRecord(event) || event.type !== "message" || !isRecord(event.message)) {
    return false;
  }
  return event.message.role === "user" && !isOwnerUserMessage(event);
}

function isAssistantMessage(event: TranscriptEvent): boolean {
  return (
    isRecord(event) &&
    event.type === "message" &&
    isRecord(event.message) &&
    event.message.role === "assistant"
  );
}

/**
 * Filters transcript events to owner-authored user turns plus the
 * assistant turns that directly follow them. Non-message events (tool
 * calls, system, compaction, reset) and non-owner user turns (with their
 * following assistant replies) are excluded entirely.
 */
function filterOwnerConversation(events: readonly TranscriptEvent[]): EpisodeMessage[] {
  const result: EpisodeMessage[] = [];
  let inOwnerTurn = false;
  for (const event of events) {
    if (isOwnerUserMessage(event)) {
      inOwnerTurn = true;
      const text =
        isRecord(event) && isRecord(event.message)
          ? extractTextContent(event.message.content)
          : undefined;
      if (text) {
        result.push({ role: "user", text });
      }
      continue;
    }
    if (isNonOwnerUserMessage(event)) {
      inOwnerTurn = false;
      continue;
    }
    if (isAssistantMessage(event) && inOwnerTurn) {
      const text =
        isRecord(event) && isRecord(event.message)
          ? extractTextContent(event.message.content)
          : undefined;
      if (text) {
        result.push({ role: "assistant", text });
      }
      continue;
    }
    // All other event types (tool calls, system, compaction, reset, and
    // assistant messages not following an owner turn) are excluded.
  }
  return result;
}

/**
 * Slices `events` to only those after `lastEventId` (exclusive). If
 * `lastEventId` is undefined (no prior cursor), returns the full window.
 * If `lastEventId` is not found in `events` (e.g. compaction dropped it,
 * or the window was reset), falls back to the full window with a warning
 * -- over-capture is the safe direction under the completeness-first
 * priority; silently emitting nothing would lose data.
 */
function selectPostCursorSlice(
  events: readonly TranscriptEvent[],
  lastEventId: string | undefined,
  scope: FlushScope,
): TranscriptEvent[] {
  if (!lastEventId) {
    return [...events];
  }
  const idx = events.findIndex((event, i) => eventId(event, i) === lastEventId);
  if (idx === -1) {
    log.warn("Flush cursor's lastEventId not found in current window; flushing full window", {
      sessionId: scope.sessionId,
      lastEventId,
    });
    return [...events];
  }
  return events.slice(idx + 1);
}

function channelLabelFromSessionKey(sessionKey: string): string {
  // Session keys look like agent:<agentId>:<channel>:<...>; fall back to
  // the whole key when the shape doesn't match.
  const parts = sessionKey.split(":");
  return parts.length >= 3 ? (parts[2] ?? sessionKey) : sessionKey;
}

function summarizeFirstOwnerMessage(messages: readonly EpisodeMessage[]): string {
  const first = messages.find((m) => m.role === "user");
  const text = (first?.text ?? "").replace(/\s+/g, " ").trim();
  if (!text) {
    return "(no owner message text)";
  }
  const truncated = text.length > 80 ? `${text.slice(0, 79)}…` : text;
  return `"${truncated}"`;
}

function pickDateTimeParts(
  date: Date,
  timeZone: string,
): { dateStr: string; timeStr: string; timeSlug: string } {
  const parts = new Intl.DateTimeFormat("en-US", {
    timeZone,
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
    second: "2-digit",
    hourCycle: "h23",
  }).formatToParts(date);
  const get = (type: Intl.DateTimeFormatPartTypes) => parts.find((p) => p.type === type)?.value;
  const year = get("year") ?? String(date.getFullYear()).padStart(4, "0");
  const month = get("month") ?? String(date.getMonth() + 1).padStart(2, "0");
  const day = get("day") ?? String(date.getDate()).padStart(2, "0");
  const hour = get("hour") ?? String(date.getHours()).padStart(2, "0");
  const minute = get("minute") ?? String(date.getMinutes()).padStart(2, "0");
  const second = get("second") ?? String(date.getSeconds()).padStart(2, "0");
  return {
    dateStr: `${year}-${month}-${day}`,
    timeStr: `${hour}:${minute}:${second}`,
    timeSlug: `${hour}${minute}`,
  };
}

/**
 * Atomically claims and writes an episode filename.
 *
 * Two properties are both required and both handled here:
 * 1. Name-claim race safety: several tracked sessions can flush
 *    concurrently (Promise.allSettled on gateway:shutdown), so two
 *    sessions must not be able to observe the same available name and
 *    clobber each other.
 * 2. Write atomicity: episode files are append-only-forever by policy
 *    and get uploaded to minky by sync-memory-to-minky.sh, so a write
 *    interrupted mid-flight (e.g. SIGKILL during a shutdown flush --
 *    Promise.race in server-close.ts stops awaiting the hook but does not
 *    cancel it) must never leave a permanently truncated record.
 *
 * The content is written in full to a private temp file first, then
 * linked into place under the target name with `fs.link` (fails with
 * EEXIST if the name is already taken, satisfying (1)) and the temp file
 * is removed. `link` succeeding means the destination now has the fully
 * written content or does not exist at all -- never a partial write (2).
 */
async function writeEpisodeFileWithAvailableName(params: {
  dir: string;
  dateStr: string;
  timeSlug: string;
  content: string;
}): Promise<string> {
  const basename = `${params.dateStr}-${params.timeSlug}`;
  const tmpPath = path.join(
    params.dir,
    `.episode-${process.pid}-${Date.now()}-${Math.random().toString(36).slice(2)}.tmp`,
  );
  await fs.writeFile(tmpPath, params.content, "utf-8");
  try {
    let suffix = 1;
    while (true) {
      const filename = suffix === 1 ? `${basename}.md` : `${basename}-${suffix}.md`;
      try {
        await fs.link(tmpPath, path.join(params.dir, filename));
        return filename;
      } catch (err) {
        if ((err as { code?: string }).code === "EEXIST") {
          suffix += 1;
          continue;
        }
        throw err;
      }
    }
  } finally {
    await fs.rm(tmpPath, { force: true });
  }
}

function episodesDir(): string {
  // Override exists for tests only, consistent with the OPENCLAW_STATE_DIR
  // convention -- production always uses the real Gaeyang path.
  const override = process.env.OPENCLAW_MEMORY_WRITE_EPISODES_DIR?.trim();
  if (override) {
    return override;
  }
  return path.join(os.homedir(), "Simon", "Gaeyang", ".memory", "episodes", "openclaw");
}

// Per-session flush serialization: keyed by `storePath::sessionId`, so
// two flushes for different sessions can proceed concurrently but two
// flushes for the SAME session (e.g. a shutdown flush racing a
// near-simultaneous auto-reset flush) are strictly ordered. This is the
// actual race guard for cross-trigger dedup -- it does not depend on any
// assumption about server-close.ts's hook emission ordering.
const sessionFlushChains = new Map<string, Promise<unknown>>();

function enqueueSessionFlush<T>(scope: FlushScope, op: () => Promise<T>): Promise<T> {
  const key = `${scope.storePath}::${scope.sessionId}`;
  const prior = sessionFlushChains.get(key) ?? Promise.resolve();
  const result = prior.then(op, op);
  sessionFlushChains.set(
    key,
    result.catch(() => undefined),
  );
  return result;
}

/**
 * Flushes one session's unflushed owner-authored conversation to a new
 * gyeol episode record, or is a no-op if there is nothing new to flush.
 * Never throws: all errors are logged and swallowed (fail-open).
 */
export function flushSession(
  scope: FlushScope,
  trigger: FlushTrigger,
  cfg: OpenClawConfig | undefined,
): Promise<void> {
  return enqueueSessionFlush(scope, async () => {
    try {
      const cursor = await readCursor(scope);
      const rawEvents = loadTranscriptEventsSync({
        agentId: scope.agentId,
        sessionId: scope.sessionId,
        sessionKey: scope.sessionKey,
        storePath: scope.storePath,
      });
      const windowEvents = selectCurrentMemoryWindow(rawEvents);
      const sliceEvents = selectPostCursorSlice(windowEvents, cursor?.lastEventId, scope);
      if (sliceEvents.length === 0) {
        log.debug("No new transcript events since last cursor; skipping flush", {
          sessionId: scope.sessionId,
          trigger,
        });
        return;
      }

      const ownerMessages = filterOwnerConversation(sliceEvents);
      if (ownerMessages.length === 0) {
        log.debug("No owner messages in flush window; skipping flush", {
          sessionId: scope.sessionId,
          trigger,
        });
        return;
      }

      const now = new Date();
      const timeZone = resolveUserTimezone(cfg?.agents?.defaults?.userTimezone ?? process.env.TZ);
      const { dateStr, timeStr, timeSlug } = pickDateTimeParts(now, timeZone);
      const channelLabel = channelLabelFromSessionKey(scope.sessionKey);

      const dir = episodesDir();
      await fs.mkdir(dir, { recursive: true });

      const markdown = formatEpisodeMarkdown(ownerMessages, {
        dateStr,
        timeStr,
        timeZone,
        channel: channelLabel,
        sessionKey: scope.sessionKey,
        trigger,
        partial: trigger !== "auto-reset",
      });

      // Episode files are append-only-forever by policy and get uploaded
      // to minky by sync-memory-to-minky.sh, so a write must not leave a
      // permanently truncated record, and the name-claim must be race-safe
      // when multiple sessions flush concurrently (see doc comment above).
      const filename = await writeEpisodeFileWithAvailableName({
        dir,
        dateStr,
        timeSlug,
        content: markdown,
      });

      const summary = summarizeFirstOwnerMessage(ownerMessages);
      await appendToRecentIndex({
        dateStr,
        channelLabel: `openclaw/${channelLabel}`,
        summary: `${summary} (${ownerMessages.length} messages)`,
        relativeEpisodePath: `episodes/openclaw/${filename}`,
      });

      const lastIndex = sliceEvents.length - 1;
      const newCursor: FlushCursor = {
        lastEventId: eventId(sliceEvents[lastIndex], lastIndex),
        lastFlushedAt: now.toISOString(),
        messageCount: (cursor?.messageCount ?? 0) + ownerMessages.length,
        lastTrigger: trigger,
      };
      // Cursor only advances after both the episode file and the
      // _recent.md entry are durably written above (AC 12): a failure
      // anywhere earlier leaves the cursor untouched, so the next flush
      // retries the same messages instead of losing them.
      await advanceCursor(scope, newCursor);

      log.info("Flushed OpenClaw session to gyeol memory", {
        sessionId: scope.sessionId,
        trigger,
        filePath: path.join(dir, filename),
        messageCount: ownerMessages.length,
      });
    } catch (err) {
      log.error("Flush failed", {
        sessionId: scope.sessionId,
        trigger,
        error: String(err),
      });
    }
  });
}
