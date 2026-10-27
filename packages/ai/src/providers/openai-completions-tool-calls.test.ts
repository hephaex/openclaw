import { describe, expect, it } from "vitest";
import { finalizeOpenAICompletionsToolCalls } from "./openai-completions-tool-calls.js";

type Block = {
  type: string;
  id?: unknown;
  name?: unknown;
  arguments?: unknown;
  partialArgs?: unknown;
};

function makeOutput(toolCall: Block) {
  return {
    content: [toolCall] as Block[],
    stopReason: "toolUse",
    errorMessage: undefined as string | undefined,
  };
}

describe("finalizeOpenAICompletionsToolCalls", () => {
  it("keeps a complete tool call", () => {
    const output = makeOutput({
      type: "toolCall",
      id: "call_ok",
      name: "bash",
      arguments: {},
      partialArgs: '{"cmd":"echo hi"}',
    });

    finalizeOpenAICompletionsToolCalls(output);

    expect(output.stopReason).toBe("toolUse");
    expect(output.content).toHaveLength(1);
    expect(output.content[0]?.arguments).toEqual({ cmd: "echo hi" });
  });

  it.each([
    { name: "empty", id: "" },
    { name: "whitespace-only", id: "   " },
    { name: "missing", id: undefined },
  ])("rejects a tool call whose id is $name", ({ id }) => {
    const output = makeOutput({
      type: "toolCall",
      id,
      name: "bash",
      arguments: {},
      partialArgs: '{"cmd":"echo hi"}',
    });

    finalizeOpenAICompletionsToolCalls(output);

    expect(output.stopReason).toBe("error");
    expect(output.errorMessage).toBe("Provider returned an incomplete or malformed tool call");
    expect(output.content).toStrictEqual([]);
  });
});
