import { describe, expect, it } from "vitest";
import { redactSecrets } from "./redact.js";

describe("redactSecrets", () => {
  it("redacts an OpenAI-style sk- key", () => {
    const text = "here is my key sk-proj-abcdefghijklmnopqrstuvwxyz0123456789ABCD";
    expect(redactSecrets(text)).toContain("[REDACTED:API key (sk/pk prefix)]");
    expect(redactSecrets(text)).not.toContain("sk-proj-abcdefghijklmnopqrstuvwxyz0123456789ABCD");
  });

  it("redacts an AWS access key", () => {
    const text = "AKIA1234567890ABCDEF is my aws key";
    expect(redactSecrets(text)).toContain("[REDACTED:AWS access key]");
  });

  it("redacts a GitHub token", () => {
    const text = "token: ghp_abcdefghijklmnopqrstuvwxyz0123456789ABCD";
    expect(redactSecrets(text)).toContain("[REDACTED:GitHub token]");
  });

  it("redacts a Slack token", () => {
    const text = "slack bot token xoxb-1234567890-abcdefghij";
    expect(redactSecrets(text)).toContain("[REDACTED:Slack token]");
  });

  it("redacts a realistic PyPI token including special base64 characters", () => {
    // Real PyPI tokens are pypi- followed by base64 that commonly includes
    // -, _, and = -- a plain [A-Za-z0-9]-only charset would miss these.
    const text = "pypi-AgEIcHlwaS5vcmcCJDdlM2Y_ZDU5LTU4YTAtNDQ4Ny1hMzZmLTAyZmU2ZDA2ZjUxNQ==";
    expect(redactSecrets(text)).toContain("[REDACTED:PyPI token]");
  });

  it("redacts a JWT", () => {
    const text =
      "auth is eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJzdWIiOiIxMjM0NTY3ODkwIn0.dQw4w9WgXcQ_dQw4w9WgXcQ_dQw4w9WgXcQ";
    expect(redactSecrets(text)).toContain("[REDACTED:JWT]");
  });

  it("redacts a PEM private key block", () => {
    const text = [
      "-----BEGIN RSA PRIVATE KEY-----",
      "MIIBOgIBAAJBAK...",
      "-----END RSA PRIVATE KEY-----",
    ].join("\n");
    expect(redactSecrets(text)).toContain("[REDACTED:PEM private key]");
  });

  it("redacts an Authorization: Bearer header", () => {
    const text = "Authorization: Bearer abcdefghijklmnopqrstuvwxyz0123456789";
    expect(redactSecrets(text)).toContain("[REDACTED:Bearer header]");
  });

  it("redacts a key=value secret assignment", () => {
    const text = "password: hunter2hunter2hunter2extra";
    expect(redactSecrets(text)).toContain("[REDACTED:key-value secret]");
  });

  it("redacts the generic 40+ char opaque string as an intentional catch-all", () => {
    // No recognized prefix, 44 characters -- documents the user-mandated
    // broad pattern: this also matches non-secret opaque strings (UUIDs
    // without dashes, hex digests, git SHAs) and that over-matching is
    // accepted by explicit user decision, not a bug to "fix" by narrowing.
    const opaque = "a".repeat(20) + "B".repeat(20) + "1234";
    expect(opaque.length).toBeGreaterThanOrEqual(40);
    const text = `random id ${opaque} in the message`;
    expect(redactSecrets(text)).toContain("[REDACTED:long opaque string]");
  });

  it("prefers a specific pattern's label over the generic catch-all when both could match", () => {
    const text = "ghp_abcdefghijklmnopqrstuvwxyz0123456789ABCD";
    const result = redactSecrets(text);
    expect(result).toContain("[REDACTED:GitHub token]");
    expect(result).not.toContain("[REDACTED:long opaque string]");
  });

  it("does not redact a 39-character opaque string (boundary check)", () => {
    const opaque = "a".repeat(39);
    expect(opaque.length).toBe(39);
    const text = `short id ${opaque} here`;
    expect(redactSecrets(text)).toBe(text);
  });

  it("leaves normal prose unchanged", () => {
    const text = "Let's meet tomorrow at 3pm to discuss the roadmap.";
    expect(redactSecrets(text)).toBe(text);
  });

  it("redacts secrets while preserving surrounding text", () => {
    const text = "Before AKIA1234567890ABCDEF after";
    const result = redactSecrets(text);
    expect(result).toBe("Before [REDACTED:AWS access key] after");
  });

  it("handles an empty string", () => {
    expect(redactSecrets("")).toBe("");
  });

  it("handles a string with no matches", () => {
    const text = "just some short ordinary text";
    expect(redactSecrets(text)).toBe(text);
  });
});
