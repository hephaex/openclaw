/**
 * openclaw-memory-write hook
 *
 * Writes owner-authored conversation content to gyeol/minky long-term
 * memory on two trigger families:
 *
 * 1. `session:auto-reset` (daily/idle) — the normal per-session boundary,
 *    same event session-memory already handles.
 * 2. `gateway:shutdown` / `gateway:pre-restart` — process-wide events that
 *    fire independently of the plugin-only shutdown drain
 *    (`drainActiveSessionsForShutdown`), enumerating every still-live
 *    session via `listActiveSessionsForShutdown()` and flushing whatever
 *    owner messages exist so far, even mid-conversation.
 *
 * A persisted per-session flush cursor (see cursor.ts) makes the two
 * trigger families idempotent with respect to each other across gateway
 * restarts on the clean path: a session flushed once on shutdown and
 * again later at a normal auto-reset does not re-emit the same messages.
 * This degrades to at-least-once under interruption or a mid-flush write
 * failure by explicit design -- the cursor only advances after both the
 * episode file and the _recent.md entry are durably written, so a
 * failure anywhere earlier is retried (a possible duplicate) rather than
 * lost. Duplicates are accepted; loss is not.
 *
 * Ordering contract this hook depends on for shutdown COVERAGE (not for
 * cursor correctness, which comes from flush.ts's per-session
 * serialization): src/gateway/server-close.ts runs the
 * `gateway:shutdown`/`gateway:pre-restart` hook steps BEFORE
 * `drainActiveSessionsForShutdown`, which empties the active-sessions
 * tracker. If those steps are ever reordered, `listActiveSessionsForShutdown()`
 * returns empty here and shutdown capture silently stops (a warning is
 * logged so this is visible, not silent). Per the ralplan final plan: if
 * implementation or later maintenance discovers this ordering has moved,
 * stop and escalate rather than modifying gateway shutdown source to
 * compensate.
 */

import type { OpenClawConfig } from "../../../config/types.openclaw.js";
import { listActiveSessionsForShutdown } from "../../../gateway/active-sessions-shutdown-tracker.js";
import { createSubsystemLogger } from "../../../logging/subsystem.js";
import type { HookHandler } from "../../hooks.js";
import { isSessionAutoResetReason } from "../../session-auto-reset.js";
import { flushSession, type FlushScope } from "./flush.js";

const log = createSubsystemLogger("hooks/openclaw-memory-write");

function requireStringField(value: unknown, field: string): string {
  if (typeof value !== "string" || value.trim().length === 0) {
    throw new Error(`openclaw-memory-write hook contract requires context.${field}`);
  }
  return value;
}

const handler: HookHandler = (event) => {
  // Path 1: per-session natural boundary (session:auto-reset, daily/idle).
  if (event.type === "session" && event.action === "auto-reset") {
    const context = event.context as {
      reason?: unknown;
      agentId?: unknown;
      storePath?: unknown;
      sessionEntry?: { sessionId?: unknown };
      cfg?: OpenClawConfig;
    };
    if (!isSessionAutoResetReason(context.reason)) {
      return undefined;
    }
    try {
      const scope: FlushScope = {
        agentId: requireStringField(context.agentId, "agentId"),
        sessionId: requireStringField(context.sessionEntry?.sessionId, "sessionEntry.sessionId"),
        sessionKey: event.sessionKey,
        storePath: requireStringField(context.storePath, "storePath"),
      };
      return flushSession(scope, "auto-reset", context.cfg).catch((err: unknown) => {
        log.error("auto-reset flush failed outside flushSession's own fail-open boundary", {
          error: String(err),
        });
      });
    } catch (err) {
      log.warn("Skipping auto-reset flush: missing required event context", {
        error: String(err),
      });
      return undefined;
    }
  }

  // Path 2: process-wide shutdown / restart (new: covers sessions that
  // never reach a natural session:auto-reset boundary).
  if (event.type === "gateway" && (event.action === "shutdown" || event.action === "pre-restart")) {
    const context = event.context as { cfg?: OpenClawConfig };
    const sessions = listActiveSessionsForShutdown();
    if (sessions.length === 0) {
      // This is the visible symptom of the ordering contract documented
      // above breaking (a future server-close.ts reorder running the
      // shutdown drain before the gateway hook steps). It is also the
      // completely normal, expected outcome when the gateway is shutting
      // down with zero live sessions. Both are logged at warn (not debug)
      // so the ordering-break case is actually visible under a default
      // console threshold, per this hook's own documented safety-net
      // promise -- an operator cannot distinguish the two cases from this
      // log line alone, but that is an acceptable false-positive rate for
      // a rare event, in exchange for the ordering break never being silent.
      log.warn("No active sessions tracked at gateway event; nothing to flush", {
        action: event.action,
      });
      return undefined;
    }
    const trigger = event.action === "shutdown" ? "shutdown" : "pre-restart";
    return Promise.allSettled(
      sessions.map((s) =>
        flushSession(
          {
            agentId: s.agentId,
            sessionId: s.sessionId,
            sessionKey: s.sessionKey,
            storePath: s.storePath,
          },
          trigger,
          s.cfg ?? context.cfg,
        ),
      ),
    ).then(() => undefined);
  }

  return undefined;
};

export default handler;
