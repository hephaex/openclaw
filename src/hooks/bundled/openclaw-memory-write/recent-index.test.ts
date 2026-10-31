import fs from "node:fs/promises";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { useAutoCleanupTempDirTracker } from "../../../../test/helpers/temp-dir.js";
import { appendToRecentIndex } from "./recent-index.js";

const tempDirs = useAutoCleanupTempDirTracker(afterEach);

describe("appendToRecentIndex", () => {
  let tempDir = "";
  let recentIndexPath = "";

  beforeEach(() => {
    tempDir = tempDirs.make("openclaw-memory-write-recent-index-");
    recentIndexPath = path.join(tempDir, "_recent.md");
    // resolveRecentIndexPath() reads this env var at call time, so no
    // module reset is needed between tests.
    process.env.OPENCLAW_MEMORY_WRITE_RECENT_INDEX_PATH = recentIndexPath;
  });

  afterEach(() => {
    delete process.env.OPENCLAW_MEMORY_WRITE_RECENT_INDEX_PATH;
  });

  it("creates the file with a Daily Index section when none exists", async () => {
    await appendToRecentIndex({
      dateStr: "2026-09-04",
      channelLabel: "openclaw/telegram",
      summary: '"Hello there"',
      relativeEpisodePath: "episodes/openclaw/2026-09-04-1422.md",
    });
    const content = await fs.readFile(recentIndexPath, "utf-8");
    expect(content).toContain("## Daily Index");
    expect(content).toContain("2026-09-04 (openclaw/telegram)");
    expect(content).toContain("episodes/openclaw/2026-09-04-1422.md");
  });

  it("inserts the new entry at the end of Daily Index, before Still Open", async () => {
    const existing = [
      "# Recent Activity",
      "",
      "## Daily Index",
      "",
      "- **2026-09-01** existing entry",
      "## Still Open",
      "",
      "- some open item",
      "",
    ].join("\n");
    await fs.writeFile(recentIndexPath, existing, "utf-8");

    await appendToRecentIndex({
      dateStr: "2026-09-04",
      channelLabel: "openclaw/telegram",
      summary: '"New message"',
      relativeEpisodePath: "episodes/openclaw/2026-09-04-1500.md",
    });

    const content = await fs.readFile(recentIndexPath, "utf-8");
    const dailyIdx = content.indexOf("## Daily Index");
    const existingIdx = content.indexOf("existing entry");
    const newEntryIdx = content.indexOf("New message");
    const stillOpenIdx = content.indexOf("## Still Open");
    expect(dailyIdx).toBeLessThan(existingIdx);
    expect(existingIdx).toBeLessThan(newEntryIdx);
    expect(newEntryIdx).toBeLessThan(stillOpenIdx);
  });

  it("matches the expected compact entry pattern", async () => {
    await appendToRecentIndex({
      dateStr: "2026-09-04",
      channelLabel: "openclaw/discord",
      summary: '"Some summary"',
      relativeEpisodePath: "episodes/openclaw/2026-09-04-0900.md",
    });
    const content = await fs.readFile(recentIndexPath, "utf-8");
    expect(content).toMatch(
      /- \*\*2026-09-04 \(openclaw\/discord\)\*\* — "Some summary"\. → `episodes\/openclaw\/2026-09-04-0900\.md`/,
    );
  });

  it("serializes concurrent writes so both entries persist without corruption", async () => {
    await Promise.all([
      appendToRecentIndex({
        dateStr: "2026-09-04",
        channelLabel: "openclaw/telegram",
        summary: '"First concurrent"',
        relativeEpisodePath: "episodes/openclaw/2026-09-04-a.md",
      }),
      appendToRecentIndex({
        dateStr: "2026-09-04",
        channelLabel: "openclaw/discord",
        summary: '"Second concurrent"',
        relativeEpisodePath: "episodes/openclaw/2026-09-04-b.md",
      }),
    ]);
    const content = await fs.readFile(recentIndexPath, "utf-8");
    expect(content).toContain("First concurrent");
    expect(content).toContain("Second concurrent");
    // Both full lines must be intact -- not interleaved/truncated.
    expect(content).toMatch(/episodes\/openclaw\/2026-09-04-a\.md`/);
    expect(content).toMatch(/episodes\/openclaw\/2026-09-04-b\.md`/);
  });
});
