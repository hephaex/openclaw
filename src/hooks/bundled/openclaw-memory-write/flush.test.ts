import fs from "node:fs/promises";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { useAutoCleanupTempDirTracker } from "../../../../test/helpers/temp-dir.js";
import { replaceTranscriptEvents } from "../../../config/sessions/session-accessor.js";

const tempDirs = useAutoCleanupTempDirTracker(afterEach);

function ownerMessageEvent(id: string, parentId: string | null, text: string) {
  return {
    type: "message",
    id,
    parentId,
    message: { role: "user", content: text, __openclaw: { senderIsOwner: true } },
  };
}

function nonOwnerMessageEvent(id: string, parentId: string | null, text: string) {
  return {
    type: "message",
    id,
    parentId,
    message: { role: "user", content: text, __openclaw: { senderIsOwner: false } },
  };
}

function assistantMessageEvent(id: string, parentId: string | null, text: string) {
  return {
    type: "message",
    id,
    parentId,
    message: { role: "assistant", content: text },
  };
}

async function freshFlushModule() {
  vi.resetModules();
  return import("./flush.js");
}

describe("flushSession", () => {
  let tempDir = "";
  let stateDir = "";
  let episodesDir = "";
  let recentIndexPath = "";
  let storePath = "";

  beforeEach(() => {
    tempDir = tempDirs.make("openclaw-memory-write-flush-");
    stateDir = path.join(tempDir, "state");
    episodesDir = path.join(tempDir, "episodes-openclaw");
    recentIndexPath = path.join(tempDir, "_recent.md");
    storePath = path.join(tempDir, "sessions.json");
    process.env.OPENCLAW_STATE_DIR = stateDir;
    process.env.OPENCLAW_MEMORY_WRITE_EPISODES_DIR = episodesDir;
    process.env.OPENCLAW_MEMORY_WRITE_RECENT_INDEX_PATH = recentIndexPath;
  });

  afterEach(() => {
    delete process.env.OPENCLAW_STATE_DIR;
    delete process.env.OPENCLAW_MEMORY_WRITE_EPISODES_DIR;
    delete process.env.OPENCLAW_MEMORY_WRITE_RECENT_INDEX_PATH;
  });

  function scope(sessionId: string) {
    return {
      agentId: "main",
      sessionId,
      sessionKey: `agent:main:telegram:${sessionId}`,
      storePath,
    };
  }

  it("with no prior cursor, flushes the entire current memory window", async () => {
    const { flushSession } = await freshFlushModule();
    const sessionId = "session-full-window";
    await replaceTranscriptEvents(
      { agentId: "main", sessionId, sessionKey: `agent:main:telegram:${sessionId}`, storePath },
      [ownerMessageEvent("u1", null, "Hello"), assistantMessageEvent("a1", "u1", "Hi there")],
    );
    await flushSession(scope(sessionId), "auto-reset", undefined);

    const files = await fs.readdir(episodesDir);
    expect(files).toHaveLength(1);
    const content = await fs.readFile(path.join(episodesDir, files[0]!), "utf-8");
    expect(content).toContain("Hello");
    expect(content).toContain("Hi there");
  });

  it("with a cursor mid-window, flushes only events after lastEventId", async () => {
    await freshFlushModule();
    const cursorMod = await import("./cursor.js");
    const { flushSession } = await import("./flush.js");
    const sessionId = "session-mid-window";
    const sessionScope = { storePath, sessionId };
    await cursorMod.advanceCursor(sessionScope, {
      lastEventId: "u1",
      lastFlushedAt: new Date().toISOString(),
      messageCount: 1,
      lastTrigger: "auto-reset",
    });
    await replaceTranscriptEvents(
      { agentId: "main", sessionId, sessionKey: `agent:main:telegram:${sessionId}`, storePath },
      [
        ownerMessageEvent("u1", null, "Already flushed message"),
        assistantMessageEvent("a1", "u1", "Already flushed reply"),
        ownerMessageEvent("u2", "a1", "New message"),
        assistantMessageEvent("a2", "u2", "New reply"),
      ],
    );
    await flushSession(scope(sessionId), "auto-reset", undefined);

    const files = await fs.readdir(episodesDir);
    expect(files).toHaveLength(1);
    const content = await fs.readFile(path.join(episodesDir, files[0]!), "utf-8");
    expect(content).not.toContain("Already flushed message");
    expect(content).toContain("New message");
    expect(content).toContain("New reply");
  });

  it("with a cursor at the window end, flushes nothing and writes no file (AC 8)", async () => {
    const { flushSession } = await freshFlushModule();
    const cursorMod = await import("./cursor.js");
    const sessionId = "session-at-end";
    const sessionScope = { storePath, sessionId };
    await replaceTranscriptEvents(
      { agentId: "main", sessionId, sessionKey: `agent:main:telegram:${sessionId}`, storePath },
      [ownerMessageEvent("u1", null, "Only message")],
    );
    await cursorMod.advanceCursor(sessionScope, {
      lastEventId: "u1",
      lastFlushedAt: new Date().toISOString(),
      messageCount: 1,
      lastTrigger: "auto-reset",
    });
    await flushSession(scope(sessionId), "auto-reset", undefined);

    await expect(fs.access(episodesDir)).rejects.toMatchObject({ code: "ENOENT" });
  });

  it("produces no file when the transcript has zero owner-authored messages", async () => {
    const { flushSession } = await freshFlushModule();
    const sessionId = "session-no-owner";
    await replaceTranscriptEvents(
      { agentId: "main", sessionId, sessionKey: `agent:main:telegram:${sessionId}`, storePath },
      [
        nonOwnerMessageEvent("u1", null, "Someone else talking"),
        assistantMessageEvent("a1", "u1", "Reply to someone else"),
      ],
    );
    await flushSession(scope(sessionId), "auto-reset", undefined);
    await expect(fs.access(episodesDir)).rejects.toMatchObject({ code: "ENOENT" });
  });

  it("excludes non-owner messages and their assistant replies from a mixed transcript", async () => {
    const { flushSession } = await freshFlushModule();
    const sessionId = "session-mixed";
    await replaceTranscriptEvents(
      { agentId: "main", sessionId, sessionKey: `agent:main:telegram:${sessionId}`, storePath },
      [
        ownerMessageEvent("u1", null, "Owner message one"),
        assistantMessageEvent("a1", "u1", "Reply to owner"),
        nonOwnerMessageEvent("u2", "a1", "Other participant"),
        assistantMessageEvent("a2", "u2", "Reply to other participant"),
        ownerMessageEvent("u3", "a2", "Owner message two"),
        assistantMessageEvent("a3", "u3", "Reply to owner two"),
      ],
    );
    await flushSession(scope(sessionId), "auto-reset", undefined);
    const files = await fs.readdir(episodesDir);
    const content = await fs.readFile(path.join(episodesDir, files[0]!), "utf-8");
    expect(content).toContain("Owner message one");
    expect(content).toContain("Reply to owner");
    expect(content).toContain("Owner message two");
    expect(content).toContain("Reply to owner two");
    expect(content).not.toContain("Other participant");
    expect(content).not.toContain("Reply to other participant");
  });

  it("never throws on a transcript read failure (fail-open)", async () => {
    const { flushSession } = await freshFlushModule();
    await expect(
      flushSession(
        {
          agentId: "main",
          sessionId: "nonexistent",
          sessionKey: "agent:main:x",
          storePath: "/nonexistent/store.json",
        },
        "auto-reset",
        undefined,
      ),
    ).resolves.toBeUndefined();
  });

  it("does not advance the cursor when the episode file write fails", async () => {
    // Force the write to fail at the OS level (not a mock): pre-create the
    // target episodes directory PATH as a regular file, so fs.mkdir(dir,
    // {recursive:true}) fails with ENOTDIR/EEXIST inside flushSession's
    // try/catch. This is the failure AC 12 and Pre-Mortem 2 require the
    // cursor to stay unadvanced for.
    const sessionId = "session-episode-write-fails";
    await replaceTranscriptEvents(
      { agentId: "main", sessionId, sessionKey: `agent:main:telegram:${sessionId}`, storePath },
      [ownerMessageEvent("u1", null, "Message that should survive a blocked write")],
    );
    await fs.mkdir(path.dirname(episodesDir), { recursive: true });
    await fs.writeFile(
      episodesDir,
      "this file blocks mkdir from creating a directory here",
      "utf-8",
    );

    const { flushSession } = await freshFlushModule();
    const cursorMod = await import("./cursor.js");
    await expect(flushSession(scope(sessionId), "auto-reset", undefined)).resolves.toBeUndefined();

    const cursor = await cursorMod.readCursor({ storePath, sessionId });
    expect(cursor).toBeUndefined();

    // Clean up the blocking file so a retried flush can succeed (proves
    // the at-least-once retry path actually recovers, not just that the
    // first attempt failed silently).
    await fs.rm(episodesDir, { force: true });
    await flushSession(scope(sessionId), "auto-reset", undefined);
    const recoveredCursor = await cursorMod.readCursor({ storePath, sessionId });
    expect(recoveredCursor?.lastEventId).toBe("u1");
    const files = await fs.readdir(episodesDir);
    expect(files).toHaveLength(1);
  });

  it("does not advance the cursor when the _recent.md index update fails", async () => {
    // Force appendToRecentIndex to fail by mocking the real module the
    // way flush.ts actually imports it, matching the write-episode ->
    // append-index -> advance-cursor ordering AC 12 requires.
    vi.resetModules();
    vi.doMock("./recent-index.js", async () => {
      const actual = await vi.importActual<typeof import("./recent-index.js")>("./recent-index.js");
      return {
        ...actual,
        appendToRecentIndex: vi.fn().mockRejectedValue(new Error("simulated _recent.md failure")),
      };
    });
    const { flushSession } = await import("./flush.js");
    const cursorMod = await import("./cursor.js");
    vi.doUnmock("./recent-index.js");

    const sessionId = "session-index-write-fails";
    await replaceTranscriptEvents(
      { agentId: "main", sessionId, sessionKey: `agent:main:telegram:${sessionId}`, storePath },
      [ownerMessageEvent("u1", null, "Message that should be retried after index failure")],
    );

    await expect(flushSession(scope(sessionId), "auto-reset", undefined)).resolves.toBeUndefined();

    // The episode file itself was written (at-least-once bias: duplicating
    // a written episode is accepted, losing one is not), but the cursor
    // must remain unadvanced so the next flush retries these messages.
    const filesAfterFailure = await fs.readdir(episodesDir);
    expect(filesAfterFailure).toHaveLength(1);
    const cursor = await cursorMod.readCursor({ storePath, sessionId });
    expect(cursor).toBeUndefined();

    // Retry with the real (unmocked) module: the same message is flushed
    // again into a second file (accepted duplicate), and the cursor now
    // advances correctly.
    vi.resetModules();
    const { flushSession: realFlushSession } = await import("./flush.js");
    const realCursorMod = await import("./cursor.js");
    await realFlushSession(scope(sessionId), "auto-reset", undefined);
    const filesAfterRetry = await fs.readdir(episodesDir);
    expect(filesAfterRetry).toHaveLength(2);
    const recoveredCursor = await realCursorMod.readCursor({ storePath, sessionId });
    expect(recoveredCursor?.lastEventId).toBe("u1");
  });

  it("advances the cursor exactly once on full success", async () => {
    const { flushSession } = await freshFlushModule();
    const cursorMod = await import("./cursor.js");
    const sessionId = "session-advance-once";
    const sessionScope = { storePath, sessionId };
    await replaceTranscriptEvents(
      { agentId: "main", sessionId, sessionKey: `agent:main:telegram:${sessionId}`, storePath },
      [ownerMessageEvent("u1", null, "Only owner message")],
    );
    await flushSession(scope(sessionId), "auto-reset", undefined);
    const cursor = await cursorMod.readCursor(sessionScope);
    expect(cursor?.lastEventId).toBe("u1");
    expect(cursor?.messageCount).toBe(1);
  });
});
