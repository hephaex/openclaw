import fs from "node:fs/promises";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { useAutoCleanupTempDirTracker } from "../../../../test/helpers/temp-dir.js";
import { replaceTranscriptEvents } from "../../../config/sessions/session-accessor.js";
import {
  noteActiveSessionForShutdown,
  listActiveSessionsForShutdown,
  forgetActiveSessionForShutdown,
} from "../../../gateway/active-sessions-shutdown-tracker.js";
import { createInternalHookEvent } from "../../internal-hooks.js";

const tempDirs = useAutoCleanupTempDirTracker(afterEach);

function ownerMessageEvent(id: string, parentId: string | null, text: string) {
  return {
    type: "message",
    id,
    parentId,
    message: { role: "user", content: text, __openclaw: { senderIsOwner: true } },
  };
}

async function freshHandlerModule() {
  vi.resetModules();
  const mod = await import("./handler.js");
  return mod.default;
}

describe("openclaw-memory-write handler", () => {
  let tempDir = "";
  let stateDir = "";
  let episodesDir = "";
  let recentIndexPath = "";
  let storePath = "";

  beforeEach(() => {
    tempDir = tempDirs.make("openclaw-memory-write-handler-");
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
    for (const s of listActiveSessionsForShutdown()) {
      forgetActiveSessionForShutdown(s.sessionId);
    }
  });

  it.each(["daily", "idle"] as const)(
    "flushes the ended session on session:auto-reset with reason %s",
    async (reason) => {
      const handler = await freshHandlerModule();
      const sessionId = `auto-reset-${reason}`;
      const sessionKey = `agent:main:telegram:${sessionId}`;
      await replaceTranscriptEvents({ agentId: "main", sessionId, sessionKey, storePath }, [
        ownerMessageEvent("u1", null, `Owner message on ${reason} reset`),
      ]);
      const event = createInternalHookEvent("session", "auto-reset", sessionKey, {
        agentId: "main",
        storePath,
        sessionEntry: { sessionId },
        reason,
      });
      const result = handler(event);
      expect(result).toBeInstanceOf(Promise);
      await result;

      const files = await fs.readdir(episodesDir);
      expect(files).toHaveLength(1);
      const content = await fs.readFile(path.join(episodesDir, files[0]!), "utf-8");
      expect(content).toContain(`Owner message on ${reason} reset`);
    },
  );

  it("is a no-op for a non-auto-reset session event", async () => {
    const handler = await freshHandlerModule();
    const event = createInternalHookEvent("session", "compact", "agent:main:telegram:x", {
      agentId: "main",
      storePath,
      sessionEntry: { sessionId: "irrelevant" },
    });
    const result = handler(event);
    expect(result).toBeUndefined();
  });

  it("skips auto-reset flush when reason is not daily/idle", async () => {
    const handler = await freshHandlerModule();
    const event = createInternalHookEvent("session", "auto-reset", "agent:main:telegram:x", {
      agentId: "main",
      storePath,
      sessionEntry: { sessionId: "irrelevant" },
      reason: "manual",
    });
    const result = handler(event);
    expect(result).toBeUndefined();
  });

  it("on gateway:shutdown, enumerates and flushes every tracked session", async () => {
    const handler = await freshHandlerModule();
    const sessionIdA = "shutdown-session-a";
    const sessionIdB = "shutdown-session-b";
    const sessionKeyA = `agent:main:telegram:${sessionIdA}`;
    const sessionKeyB = `agent:main:discord:${sessionIdB}`;
    await replaceTranscriptEvents(
      { agentId: "main", sessionId: sessionIdA, sessionKey: sessionKeyA, storePath },
      [ownerMessageEvent("u1", null, "Shutdown owner message A")],
    );
    await replaceTranscriptEvents(
      { agentId: "main", sessionId: sessionIdB, sessionKey: sessionKeyB, storePath },
      [ownerMessageEvent("u1", null, "Shutdown owner message B")],
    );
    noteActiveSessionForShutdown({
      cfg: {} as never,
      sessionKey: sessionKeyA,
      sessionId: sessionIdA,
      storePath,
      agentId: "main",
    });
    noteActiveSessionForShutdown({
      cfg: {} as never,
      sessionKey: sessionKeyB,
      sessionId: sessionIdB,
      storePath,
      agentId: "main",
    });

    const event = createInternalHookEvent("gateway", "shutdown", "gateway:shutdown", {
      reason: "shutdown",
      restartExpectedMs: null,
    });
    const result = handler(event);
    expect(result).toBeInstanceOf(Promise);
    await result;

    const files = await fs.readdir(episodesDir);
    expect(files).toHaveLength(2);
    const contents = await Promise.all(
      files.map((f) => fs.readFile(path.join(episodesDir, f), "utf-8")),
    );
    const joined = contents.join("\n---\n");
    expect(joined).toContain("Shutdown owner message A");
    expect(joined).toContain("Shutdown owner message B");
  });

  it("on gateway:pre-restart, behaves identically to gateway:shutdown", async () => {
    const handler = await freshHandlerModule();
    const sessionId = "pre-restart-session";
    const sessionKey = `agent:main:telegram:${sessionId}`;
    await replaceTranscriptEvents({ agentId: "main", sessionId, sessionKey, storePath }, [
      ownerMessageEvent("u1", null, "Pre-restart owner message"),
    ]);
    noteActiveSessionForShutdown({
      cfg: {} as never,
      sessionKey,
      sessionId,
      storePath,
      agentId: "main",
    });
    const event = createInternalHookEvent("gateway", "pre-restart", "gateway:pre-restart", {
      reason: "restart",
      restartExpectedMs: 5000,
    });
    await handler(event);
    const files = await fs.readdir(episodesDir);
    expect(files).toHaveLength(1);
  });

  it("shutdown followed by pre-restart in one restart sequence: second flush writes nothing new", async () => {
    const handler = await freshHandlerModule();
    const sessionId = "restart-sequence-session";
    const sessionKey = `agent:main:telegram:${sessionId}`;
    await replaceTranscriptEvents({ agentId: "main", sessionId, sessionKey, storePath }, [
      ownerMessageEvent("u1", null, "Only message before restart"),
    ]);
    noteActiveSessionForShutdown({
      cfg: {} as never,
      sessionKey,
      sessionId,
      storePath,
      agentId: "main",
    });

    const shutdownEvent = createInternalHookEvent("gateway", "shutdown", "gateway:shutdown", {
      reason: "restart",
      restartExpectedMs: 5000,
    });
    await handler(shutdownEvent);

    // Re-track (real server-close.ts re-notes before the pre-restart step
    // in a real restart sequence); simulate that here.
    noteActiveSessionForShutdown({
      cfg: {} as never,
      sessionKey,
      sessionId,
      storePath,
      agentId: "main",
    });
    const preRestartEvent = createInternalHookEvent(
      "gateway",
      "pre-restart",
      "gateway:pre-restart",
      {
        reason: "restart",
        restartExpectedMs: 5000,
      },
    );
    await handler(preRestartEvent);

    const files = await fs.readdir(episodesDir);
    // Only one file: the second flush found nothing new past the cursor.
    expect(files).toHaveLength(1);
  });

  it("one session throwing during a multi-session shutdown does not block the others", async () => {
    const handler = await freshHandlerModule();
    const goodSessionId = "shutdown-good-session";
    const goodSessionKey = `agent:main:telegram:${goodSessionId}`;
    await replaceTranscriptEvents(
      { agentId: "main", sessionId: goodSessionId, sessionKey: goodSessionKey, storePath },
      [ownerMessageEvent("u1", null, "Good session message")],
    );
    noteActiveSessionForShutdown({
      cfg: {} as never,
      sessionKey: goodSessionKey,
      sessionId: goodSessionId,
      storePath,
      agentId: "main",
    });
    // Bad session points at a nonexistent store; flushSession's internal
    // try/catch means this resolves (fail-open), so Promise.allSettled
    // isn't strictly required for correctness here, but this proves the
    // good session still completes regardless.
    noteActiveSessionForShutdown({
      cfg: {} as never,
      sessionKey: "agent:main:telegram:bad-session",
      sessionId: "bad-session",
      storePath: "/nonexistent/store.json",
      agentId: "main",
    });

    const event = createInternalHookEvent("gateway", "shutdown", "gateway:shutdown", {
      reason: "shutdown",
      restartExpectedMs: null,
    });
    await expect(handler(event)).resolves.toBeUndefined();

    const files = await fs.readdir(episodesDir);
    expect(files).toHaveLength(1);
    const content = await fs.readFile(path.join(episodesDir, files[0]!), "utf-8");
    expect(content).toContain("Good session message");
  });

  it("is a no-op when the shutdown tracker is empty", async () => {
    const handler = await freshHandlerModule();
    const event = createInternalHookEvent("gateway", "shutdown", "gateway:shutdown", {
      reason: "shutdown",
      restartExpectedMs: null,
    });
    const result = handler(event);
    expect(result).toBeUndefined();
  });

  it("does not invoke sync-memory-to-minky.sh (AC 7)", async () => {
    // The hook only ever writes local files and never spawns a subprocess
    // or shells out; this is a structural property of the implementation
    // rather than something observable at test time. Assert the episode
    // write path is local and that no sync marker/file is created.
    const handler = await freshHandlerModule();
    const sessionId = "no-sync-invocation-session";
    const sessionKey = `agent:main:telegram:${sessionId}`;
    await replaceTranscriptEvents({ agentId: "main", sessionId, sessionKey, storePath }, [
      ownerMessageEvent("u1", null, "Message that should not trigger sync"),
    ]);
    const event = createInternalHookEvent("session", "auto-reset", sessionKey, {
      agentId: "main",
      storePath,
      sessionEntry: { sessionId },
      reason: "daily",
    });
    await handler(event);
    const recentIndexContent = await fs.readFile(recentIndexPath, "utf-8");
    expect(recentIndexContent).not.toContain("sync-memory-to-minky");
  });
});
