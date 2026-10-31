/**
 * Secret redaction for openclaw-memory-write.
 *
 * 10 high-confidence, prefix-based patterns plus one broader generic
 * long-opaque-string catch-all. The generic pattern is present by explicit
 * user decision made at the ralplan approval gate (v3), overriding the
 * pass-2 Architect/Critic consensus recommendation to remove it. It is a
 * deliberate, accepted safety-over-completeness exception scoped to this
 * one pattern -- see the ralplan final plan's ADR "Design choice (user
 * override)" section. Do not remove, narrow, or reorder it without a new
 * explicit user decision.
 */

export type SecretPattern = {
  pattern: RegExp;
  label: string;
};

// Ordered so specific, high-confidence patterns match first and produce
// more informative labels; the generic catch-all is last so it only
// catches what nothing more specific already caught.
export const SECRET_PATTERNS: SecretPattern[] = [
  { pattern: /\b(?:sk-(?:proj-)?|pk-)[A-Za-z0-9_-]{32,}\b/g, label: "API key (sk/pk prefix)" },
  { pattern: /\bAKIA[A-Z0-9]{16}\b/g, label: "AWS access key" },
  { pattern: /\b(?:ghp|gho|ghu|ghs|ghr)_[A-Za-z0-9]{36,}\b/g, label: "GitHub token" },
  { pattern: /\bxox[bpras]-[A-Za-z0-9-]{10,}\b/g, label: "Slack token" },
  { pattern: /\bnpm_[A-Za-z0-9]{36,}\b/g, label: "npm token" },
  // PyPI tokens are pypi- followed by a long base64-ish payload that
  // commonly includes -, _, and = (unlike npm's plain hex UUID shape), so
  // the charset is intentionally broader than the npm pattern above.
  { pattern: /\bpypi-[A-Za-z0-9_=-]{36,}\b/g, label: "PyPI token" },
  {
    pattern: /\beyJ[A-Za-z0-9_-]{20,}\.[A-Za-z0-9_-]{20,}\.[A-Za-z0-9_-]{20,}/g,
    label: "JWT",
  },
  {
    pattern:
      /(?:api[_-]?key|token|secret|password|passwd|bearer|authorization)\s*[:=]\s*['"]?[A-Za-z0-9_\-.]{16,}['"]?/gi,
    label: "key-value secret",
  },
  {
    pattern:
      /-----BEGIN (?:RSA |EC |DSA )?PRIVATE KEY-----[\s\S]*?-----END (?:RSA |EC |DSA )?PRIVATE KEY-----/g,
    label: "PEM private key",
  },
  {
    pattern: /Authorization:\s*Bearer\s+[A-Za-z0-9_\-.]{16,}/gi,
    label: "Bearer header",
  },
  // Generic long base64-charset string -- user-mandated catch-all (see
  // module doc comment above). Intentionally broad: also matches UUIDs
  // (dashless), hex digests, git SHAs, and other long non-secret
  // identifiers. That over-matching is accepted, not a bug -- do not "fix"
  // it by narrowing the pattern or removing it.
  { pattern: /\b[A-Za-z0-9+/]{40,}={0,2}\b/g, label: "long opaque string" },
];

/** Replaces every recognized secret pattern in `text` with `[REDACTED:<label>]`. */
export function redactSecrets(text: string): string {
  let result = text;
  for (const { pattern, label } of SECRET_PATTERNS) {
    // Each pattern carries the "g" flag; reset lastIndex defensively since
    // patterns are module-level and reused across calls.
    pattern.lastIndex = 0;
    result = result.replace(pattern, `[REDACTED:${label}]`);
  }
  return result;
}
