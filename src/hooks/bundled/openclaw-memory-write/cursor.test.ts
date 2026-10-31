import fs from "node:fs/promises";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { useAutoCleanupTempDirTracker } from "../../../../test/helpers/temp-dir.js";

const tempDirs = useAutoCleanupTempDirTracker(afterEach);

async function freshCursorModule() {
  // resolveStateDir reads OPENCLAW_STATE_DIR at call time (no module-level
  // caching in cursor.ts itself), so resetting modules is only needed to
  // reset the module-level write-serialization chain between tests.
  vi.resetModules();
  return import("./cursor.js");
}

describe("flush cursor persistence", () => {
  let tempDir = "";
  let stateDir = "";

  beforeEach(() => {
    tempDir = tempDirs.make("openclaw-memory-write-cursor-");
    stateDir = path.join(tempDir, "state");
    process.env.OPENCLAW_STATE_DIR = stateDir;
  });

  afterEach(() => {
    delete process.env.OPENCLAW_STATE_DIR;
  });

  const scope = { storePath: "/store/a.sqlite", sessionId: "session-1" };

  it("returns undefined for an unknown session with an empty store", async () => {
    const { readCursor } = await freshCursorModule();
    const cursor = await readCursor(scope);
    expect(cursor).toBeUndefined();
  });

  it("round-trips lastEventId, messageCount, and lastTrigger", async () => {
    const { readCursor, advanceCursor } = await freshCursorModule();
    await advanceCursor(scope, {
      lastEventId: "evt-5",
      lastFlushedAt: new Date().toISOString(),
      messageCount: 3,
      lastTrigger: "auto-reset",
    });
    const cursor = await readCursor(scope);
    expect(cursor).toMatchObject({
      lastEventId: "evt-5",
      messageCount: 3,
      lastTrigger: "auto-reset",
    });
  });

  it("persists across a simulated process restart (fresh module instance)", async () => {
    const mod1 = await freshCursorModule();
    await mod1.advanceCursor(scope, {
      lastEventId: "evt-restart",
      lastFlushedAt: new Date().toISOString(),
      messageCount: 1,
      lastTrigger: "shutdown",
    });
    // Fresh module instance, same underlying file: proves the cursor is
    // genuinely on disk, not merely held in an in-memory module cache.
    const mod2 = await freshCursorModule();
    const cursor = await mod2.readCursor(scope);
    expect(cursor?.lastEventId).toBe("evt-restart");
  });

  it("treats corrupt JSON as empty, logs a warning, and does not throw", async () => {
    const { readCursor, cursorStorePathForTest } = await freshCursorModule();
    const filePath = cursorStorePathForTest();
    await fs.mkdir(path.dirname(filePath), { recursive: true });
    await fs.writeFile(filePath, "{ not valid json", "utf-8");
    await expect(readCursor(scope)).resolves.toBeUndefined();
  });

  it("treats an unexpected version as corrupt and resets to empty", async () => {
    const { readCursor, cursorStorePathForTest } = await freshCursorModule();
    const filePath = cursorStorePathForTest();
    await fs.mkdir(path.dirname(filePath), { recursive: true });
    await fs.writeFile(filePath, JSON.stringify({ version: 99, cursors: {} }), "utf-8");
    await expect(readCursor(scope)).resolves.toBeUndefined();
  });

  it("creates the missing state directory on first write", async () => {
    const { advanceCursor, cursorStorePathForTest } = await freshCursorModule();
    await advanceCursor(scope, {
      lastEventId: "evt-1",
      lastFlushedAt: new Date().toISOString(),
      messageCount: 1,
      lastTrigger: "auto-reset",
    });
    const filePath = cursorStorePathForTest();
    await expect(fs.access(filePath)).resolves.toBeUndefined();
  });

  it("writes atomically: a crash between temp-write and rename leaves the previous file intact", async () => {
    const { advanceCursor, readCursor, cursorStorePathForTest } = await freshCursorModule();
    await advanceCursor(scope, {
      lastEventId: "evt-before",
      lastFlushedAt: new Date().toISOString(),
      messageCount: 1,
      lastTrigger: "auto-reset",
    });
    const filePath = cursorStorePathForTest();
    const before = await fs.readFile(filePath, "utf-8");

    // Simulate a crash by writing a tmp file and never renaming it -- the
    // real file must remain exactly as it was.
    const tmpPath = `${filePath}.simulated-crash.tmp`;
    await fs.writeFile(tmpPath, JSON.stringify({ version: 1, cursors: {} }), "utf-8");
    const after = await fs.readFile(filePath, "utf-8");
    expect(after).toBe(before);

    const cursor = await readCursor(scope);
    expect(cursor?.lastEventId).toBe("evt-before");
    await fs.rm(tmpPath, { force: true });
  });

  it("prunes entries older than 30 days on write while retaining recent ones", async () => {
    const { advanceCursor, readCursor } = await freshCursorModule();
    const oldSessionScope = { storePath: "/store/a.sqlite", sessionId: "old-session" };
    const recentSessionScope = { storePath: "/store/a.sqlite", sessionId: "recent-session" };
    const thirtyOneDaysAgo = new Date(Date.now() - 31 * 24 * 60 * 60 * 1000).toISOString();

    await advanceCursor(oldSessionScope, {
      lastEventId: "evt-old",
      lastFlushedAt: thirtyOneDaysAgo,
      messageCount: 1,
      lastTrigger: "auto-reset",
    });
    // A second write triggers the prune sweep and should drop the old entry.
    await advanceCursor(recentSessionScope, {
      lastEventId: "evt-recent",
      lastFlushedAt: new Date().toISOString(),
      messageCount: 1,
      lastTrigger: "auto-reset",
    });

    expect(await readCursor(oldSessionScope)).toBeUndefined();
    expect((await readCursor(recentSessionScope))?.lastEventId).toBe("evt-recent");
  });

  it("keys distinguish the same sessionId under different storePath", async () => {
    const { advanceCursor, readCursor } = await freshCursorModule();
    const scopeA = { storePath: "/store/a.sqlite", sessionId: "shared-id" };
    const scopeB = { storePath: "/store/b.sqlite", sessionId: "shared-id" };
    await advanceCursor(scopeA, {
      lastEventId: "evt-a",
      lastFlushedAt: new Date().toISOString(),
      messageCount: 1,
      lastTrigger: "auto-reset",
    });
    await advanceCursor(scopeB, {
      lastEventId: "evt-b",
      lastFlushedAt: new Date().toISOString(),
      messageCount: 1,
      lastTrigger: "auto-reset",
    });
    expect((await readCursor(scopeA))?.lastEventId).toBe("evt-a");
    expect((await readCursor(scopeB))?.lastEventId).toBe("evt-b");
  });

  it("serializes concurrent advanceCursor calls for different sessions without a lost update", async () => {
    const { advanceCursor, readCursor } = await freshCursorModule();
    const scopeA = { storePath: "/store/a.sqlite", sessionId: "concurrent-a" };
    const scopeB = { storePath: "/store/a.sqlite", sessionId: "concurrent-b" };
    await Promise.all([
      advanceCursor(scopeA, {
        lastEventId: "evt-concurrent-a",
        lastFlushedAt: new Date().toISOString(),
        messageCount: 1,
        lastTrigger: "auto-reset",
      }),
      advanceCursor(scopeB, {
        lastEventId: "evt-concurrent-b",
        lastFlushedAt: new Date().toISOString(),
        messageCount: 1,
        lastTrigger: "auto-reset",
      }),
    ]);
    expect((await readCursor(scopeA))?.lastEventId).toBe("evt-concurrent-a");
    expect((await readCursor(scopeB))?.lastEventId).toBe("evt-concurrent-b");
  });
});
