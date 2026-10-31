/**
 * Episode markdown formatting for openclaw-memory-write.
 */

import type { FlushTrigger } from "./cursor.js";
import { redactSecrets } from "./redact.js";

export type EpisodeMessage = {
  role: "user" | "assistant";
  text: string;
};

export type EpisodeMetadata = {
  dateStr: string;
  timeStr: string;
  timeZone: string;
  channel: string;
  sessionKey: string;
  trigger: FlushTrigger;
  /** True for a shutdown/pre-restart flush that captured a mid-session, not-yet-ended conversation. */
  partial: boolean;
};

function triggerLine(metadata: EpisodeMetadata): string {
  if (metadata.trigger === "auto-reset") {
    // Reason (daily/idle) is folded into the caller's trigger label upstream
    // when relevant; keep this generic so format.ts stays decoupled from
    // session-auto-reset's reason type.
    return `- **Trigger**: session:auto-reset`;
  }
  const eventName = metadata.trigger === "shutdown" ? "gateway:shutdown" : "gateway:pre-restart";
  return metadata.partial
    ? `- **Trigger**: ${eventName} (partial capture)`
    : `- **Trigger**: ${eventName}`;
}

/** Escapes markdown syntax that could otherwise be misinterpreted as structure. */
function escapeMarkdownContent(text: string): string {
  // Escape leading markdown block markers per line (#, *, -, >, `) without
  // mangling ordinary mid-sentence punctuation. Fenced code spans are left
  // as-is; this is a memory record, not rendered UI, so readability matters
  // more than perfect markdown safety.
  return text
    .split("\n")
    .map((line) => line.replace(/^(\s*)([#*>`-])/, "$1\\$2"))
    .join("\n");
}

/** Renders one flushed conversation slice as an episode markdown document. */
export function formatEpisodeMarkdown(
  messages: readonly EpisodeMessage[],
  metadata: EpisodeMetadata,
): string {
  const header = [
    `# OpenClaw Session — ${metadata.dateStr} ${metadata.timeStr} ${metadata.timeZone}`,
    "",
    `- **Channel**: ${metadata.channel}`,
    `- **Session Key**: ${metadata.sessionKey}`,
    triggerLine(metadata),
    "",
    "## Conversation",
    "",
  ];

  const body = messages.map((message) => {
    const speaker = message.role === "user" ? "**Me**" : "**Assistant**";
    const redacted = redactSecrets(message.text);
    const escaped = escapeMarkdownContent(redacted);
    return `${speaker}: ${escaped}`;
  });

  return [...header, ...body].join("\n\n") + "\n";
}
