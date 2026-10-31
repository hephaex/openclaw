---
name: openclaw-memory-write
description: "Write owner-authored conversation content to gyeol/minky long-term memory on session end and gateway shutdown"
homepage: https://docs.openclaw.ai/automation/hooks#openclaw-memory-write
metadata:
  {
    "openclaw":
      {
        "emoji": "📝",
        "events": ["session:auto-reset", "gateway:shutdown", "gateway:pre-restart"],
        "install": [{ "id": "bundled", "kind": "bundled", "label": "Bundled with OpenClaw" }],
      },
  }
---

# OpenClaw → gyeol/minky Memory Write Hook

Writes the operator's own messages and the assistant's replies from an
OpenClaw conversation into gyeol long-term memory, so they automatically
resurface in future sessions and become available as long-term evidence in
minky — without ever persisting other participants' messages, secrets, or
requiring a manual save step for local visibility.

## What It Does

On two independent trigger families:

1. **`session:auto-reset`** (daily or idle reason) — the normal per-session
   boundary, same event `session-memory` already handles.
2. **`gateway:shutdown` / `gateway:pre-restart`** — process-wide gateway
   lifecycle events, awaited with a real timeout budget (5s / 10s). These
   fire independently of the plugin-only shutdown drain and cover sessions
   that never reach a natural `session:auto-reset` boundary (e.g. the
   process is stopped mid-conversation). Every still-live session is
   enumerated via `listActiveSessionsForShutdown()` and flushed with
   whatever owner messages exist so far, even mid-turn.

For each flush:

1. **Reads the raw transcript** — never the pre-rendered session-memory
   summary (which loses per-message ownership metadata) — via
   `loadTranscriptEventsSync()` plus the shared
   `selectCurrentMemoryWindow()` window selector.
2. **Filters to owner content** — only `message.__openclaw.senderIsOwner
=== true` user turns and the assistant turns that directly follow them.
   Non-owner participants (e.g. in a group chat) and non-message events
   (tool calls, system, compaction, reset) are excluded entirely.
3. **Redacts secrets** — a bounded, high-confidence regex blocklist
   (provider API key prefixes, AWS/GitHub/Slack/npm/PyPI tokens, JWTs, PEM
   private keys, `Authorization: Bearer` headers, plus one intentionally
   broad 40+ character opaque-string catch-all — see "Secret redaction"
   below).
4. **Writes an append-only episode file** to
   `~/Simon/Gaeyang/.memory/episodes/openclaw/YYYY-MM-DD-HHmm.md`. Files
   are never moved, renamed, or modified after creation.
5. **Indexes the new file** in `~/Simon/Gaeyang/.memory/episodes/_recent.md`,
   which the minky broker's `load_working_set` treats as a pinned
   working-set item — so it's automatically visible via the
   `gyeol-memory-bridge` hook at the very next OpenClaw session's
   bootstrap, with no manual retrieval step.
6. **Advances a persisted flush cursor** (`cursor.ts`) so the same
   messages are not re-captured across the two trigger families — including
   across a gateway restart — on the clean path: a session partially
   flushed at shutdown, then resumed and later reaching a normal
   auto-reset, produces a second, smaller episode file containing only
   the new messages. Under interruption or a mid-flush write failure this
   degrades to at-least-once by explicit design (the cursor only advances
   after both the episode file and the `_recent.md` entry are durably
   written) — a duplicate re-flush is accepted, silent loss is not.

Remote minky sync deliberately lags behind: this hook never invokes
`sync-memory-to-minky.sh` — the written files simply become visible to
that existing script on its normal manual `/save` cadence.

## Secret redaction

Ten prefix-based, high-confidence patterns (OpenAI/Stripe-style keys, AWS
access keys, GitHub/Slack/npm/PyPI tokens, JWTs, `key=value` secret
assignments, PEM private key blocks, `Authorization: Bearer` headers) plus
one broader catch-all matching any 40+ character run of base64-charset
text. That generic pattern is intentionally broad by explicit user
decision — it also matches UUIDs, hex digests, and other long non-secret
identifiers, and that over-matching is accepted, not a defect. It is not
to be removed, narrowed, or reordered without a fresh explicit decision
from the user.

## Ordering contract (informational, not user-configurable)

Shutdown coverage depends on `src/gateway/server-close.ts` running its
`gateway:shutdown` / `gateway:pre-restart` hook steps _before_
`drainActiveSessionsForShutdown` (which empties the active-sessions
tracker this hook enumerates). If that ordering ever changes,
`listActiveSessionsForShutdown()` returns empty and shutdown capture
silently stops working — a warning is logged in that case so the gap is
visible rather than silent. This hook never modifies gateway shutdown
source to compensate; an ordering change is a signal to re-plan, not to
patch around.

## Failure mode

Fully fail-open: transcript read failures, file write failures, and
`_recent.md` update failures are logged and swallowed. A flush never
blocks a successor session, and on the shutdown path a slow or failing
session's flush never prevents other tracked sessions from being flushed
(`Promise.allSettled`) or delays gateway shutdown beyond its own timeout
budget.

## Disabling

```bash
openclaw hooks disable openclaw-memory-write
```
