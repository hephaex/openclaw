import { describe, expect, it } from "vitest";
import { formatEpisodeMarkdown, type EpisodeMessage } from "./format.js";

const baseMetadata = {
  dateStr: "2026-09-04",
  timeStr: "14:22:00",
  timeZone: "Asia/Seoul",
  channel: "telegram:personal",
  sessionKey: "agent:main:telegram:personal:direct:12345",
};

describe("formatEpisodeMarkdown", () => {
  it("renders an empty message list as a header-only document", () => {
    const result = formatEpisodeMarkdown([], {
      ...baseMetadata,
      trigger: "auto-reset",
      partial: false,
    });
    expect(result).toContain("# OpenClaw Session");
    expect(result).toContain("## Conversation");
    expect(result).not.toContain("**Me**");
  });

  it("renders a single user+assistant turn", () => {
    const messages: EpisodeMessage[] = [
      { role: "user", text: "Hello there" },
      { role: "assistant", text: "Hi, how can I help?" },
    ];
    const result = formatEpisodeMarkdown(messages, {
      ...baseMetadata,
      trigger: "auto-reset",
      partial: false,
    });
    expect(result).toContain("**Me**: Hello there");
    expect(result).toContain("**Assistant**: Hi, how can I help?");
  });

  it("preserves multi-turn ordering and role labels", () => {
    const messages: EpisodeMessage[] = [
      { role: "user", text: "First" },
      { role: "assistant", text: "First reply" },
      { role: "user", text: "Second" },
      { role: "assistant", text: "Second reply" },
    ];
    const result = formatEpisodeMarkdown(messages, {
      ...baseMetadata,
      trigger: "auto-reset",
      partial: false,
    });
    const firstIdx = result.indexOf("First");
    const firstReplyIdx = result.indexOf("First reply");
    const secondIdx = result.indexOf("Second");
    const secondReplyIdx = result.indexOf("Second reply");
    expect(firstIdx).toBeLessThan(firstReplyIdx);
    expect(firstReplyIdx).toBeLessThan(secondIdx);
    expect(secondIdx).toBeLessThan(secondReplyIdx);
  });

  it("escapes leading markdown structural characters without mangling content", () => {
    const messages: EpisodeMessage[] = [
      { role: "user", text: "# Not a heading\n* not a bullet\n> not a quote" },
    ];
    const result = formatEpisodeMarkdown(messages, {
      ...baseMetadata,
      trigger: "auto-reset",
      partial: false,
    });
    expect(result).toContain("\\# Not a heading");
    expect(result).toContain("\\* not a bullet");
    expect(result).toContain("\\> not a quote");
  });

  it("preserves multi-line message content", () => {
    const messages: EpisodeMessage[] = [{ role: "user", text: "line one\nline two\nline three" }];
    const result = formatEpisodeMarkdown(messages, {
      ...baseMetadata,
      trigger: "auto-reset",
      partial: false,
    });
    expect(result).toContain("line one");
    expect(result).toContain("line two");
    expect(result).toContain("line three");
  });

  it("redacts secrets found in message content", () => {
    const messages: EpisodeMessage[] = [{ role: "user", text: "my key is AKIA1234567890ABCDEF" }];
    const result = formatEpisodeMarkdown(messages, {
      ...baseMetadata,
      trigger: "auto-reset",
      partial: false,
    });
    expect(result).toContain("[REDACTED:AWS access key]");
    expect(result).not.toContain("AKIA1234567890ABCDEF");
  });

  it("renders the auto-reset trigger line without a partial marker", () => {
    const result = formatEpisodeMarkdown([], {
      ...baseMetadata,
      trigger: "auto-reset",
      partial: false,
    });
    expect(result).toContain("- **Trigger**: session:auto-reset");
    expect(result).not.toContain("partial capture");
  });

  it("renders the shutdown trigger line with a partial marker", () => {
    const result = formatEpisodeMarkdown([], {
      ...baseMetadata,
      trigger: "shutdown",
      partial: true,
    });
    expect(result).toContain("- **Trigger**: gateway:shutdown (partial capture)");
  });

  it("renders the pre-restart trigger line with a partial marker", () => {
    const result = formatEpisodeMarkdown([], {
      ...baseMetadata,
      trigger: "pre-restart",
      partial: true,
    });
    expect(result).toContain("- **Trigger**: gateway:pre-restart (partial capture)");
  });

  it("includes channel and session key metadata", () => {
    const result = formatEpisodeMarkdown([], {
      ...baseMetadata,
      trigger: "auto-reset",
      partial: false,
    });
    expect(result).toContain("- **Channel**: telegram:personal");
    expect(result).toContain("- **Session Key**: agent:main:telegram:personal:direct:12345");
  });
});
