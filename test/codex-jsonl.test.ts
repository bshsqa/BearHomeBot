import assert from "node:assert/strict";
import test from "node:test";

import { CodexJsonlParser } from "../src/codex/jsonl.js";

test("parses chunked Codex JSONL and keeps the final agent message", () => {
  const parser = new CodexJsonlParser();
  parser.push(
    '{"type":"thread.started","thread_id":"0199a213-81c0-7800-8aa1-bbab2a035a53"}\n',
  );
  parser.push(
    '{"type":"item.completed","item":{"type":"agent_message","text":"첫 답변"}}\n' +
      '{"type":"item.completed","item":{"type":"agent_message","text":"최종',
  );
  parser.push(
    ' 답변"}}\n{"type":"turn.completed","usage":{"input_tokens":12,"cached_input_tokens":4,"output_tokens":7}}\n',
  );

  assert.deepEqual(parser.finish(), {
    threadId: "0199a213-81c0-7800-8aa1-bbab2a035a53",
    finalText: "최종 답변",
    usage: {
      inputTokens: 12,
      cachedInputTokens: 4,
      outputTokens: 7,
    },
    turnFailed: false,
  });
});

test("ignores malformed and unknown JSONL events", () => {
  const parser = new CodexJsonlParser();
  parser.push("not-json\n");
  parser.push('{"type":"unknown","secret":"must-not-surface"}\n');

  assert.deepEqual(parser.finish(), { turnFailed: false });
});

test("marks explicit Codex failures", () => {
  const parser = new CodexJsonlParser();
  parser.push('{"type":"turn.failed","error":{"message":"private detail"}}\n');

  assert.equal(parser.finish().turnFailed, true);
});
