import assert from "node:assert/strict";
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

import {
  CodexRunner,
  CodexRunnerError,
  prepareCodexWorkspace,
} from "../src/codex/runner.js";

const THREAD_ID = "0199a213-81c0-7800-8aa1-bbab2a035a53";

function fixture(scriptBody: string): {
  root: string;
  runner: CodexRunner;
} {
  const root = mkdtempSync(join(tmpdir(), "bearhomebot-codex-runner-"));
  const workspace = join(root, "workspace");
  mkdirSync(workspace);
  prepareCodexWorkspace(workspace);
  const script = join(root, "fake-codex.mjs");
  writeFileSync(script, scriptBody, { mode: 0o700 });

  return {
    root,
    runner: new CodexRunner({
      workspace,
      executable: process.execPath,
      executablePrefixArguments: [script],
      env: {
        HOME: process.env.HOME,
        PATH: process.env.PATH,
        LANG: "C.UTF-8",
        BEARHOMEBOT_TELEGRAM_TOKEN: "must-not-leak",
        KSKILL_KTX_PASSWORD: "must-not-leak",
      },
      timeoutMilliseconds: 2_000,
    }),
  };
}

test("starts Codex with stdin and a secret-free environment", async () => {
  const { root, runner } = fixture(`
    let prompt = "";
    for await (const chunk of process.stdin) prompt += chunk;
    const leaked = Boolean(
      process.env.BEARHOMEBOT_TELEGRAM_TOKEN ||
      process.env.KSKILL_KTX_PASSWORD
    );
    process.stdout.write(JSON.stringify({
      type: "thread.started",
      thread_id: "${THREAD_ID}"
    }) + "\\n");
    process.stdout.write(JSON.stringify({
      type: "item.completed",
      item: {
        type: "agent_message",
        text: leaked ? "secret leaked" : "받음: " + prompt.trim()
      }
    }) + "\\n");
    process.stdout.write(JSON.stringify({
      type: "turn.completed",
      usage: { input_tokens: 10, output_tokens: 4 }
    }) + "\\n");
  `);

  try {
    const result = await runner.run({ prompt: "안녕" });

    assert.equal(result.threadId, THREAD_ID);
    assert.equal(result.finalText, "받음: 안녕");
    assert.deepEqual(result.usage, { inputTokens: 10, outputTokens: 4 });
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("resumes only a validated Codex thread ID", async () => {
  const { root, runner } = fixture(`
    const args = process.argv.slice(2);
    const threadId = args.find((arg) => /^[0-9a-f-]{36}$/i.test(arg));
    process.stdout.write(JSON.stringify({
      type: "item.completed",
      item: { type: "agent_message", text: "resumed:" + threadId }
    }) + "\\n");
    process.stdout.write(JSON.stringify({ type: "turn.completed" }) + "\\n");
  `);

  try {
    const result = await runner.run({
      prompt: "계속",
      threadId: THREAD_ID,
    });
    assert.equal(result.finalText, `resumed:${THREAD_ID}`);

    assert.throws(
      () =>
        runner.run({
          prompt: "위험",
          threadId: "--dangerously-bypass-approvals-and-sandbox",
        }),
      (error: unknown) =>
        error instanceof CodexRunnerError && error.code === "invalid_thread_id",
    );
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("times out a stalled Codex process", async () => {
  const { root, runner } = fixture(`
    setTimeout(() => undefined, 60_000);
  `);
  const fastRunner = new CodexRunner({
    workspace: join(root, "workspace"),
    executable: process.execPath,
    executablePrefixArguments: [join(root, "fake-codex.mjs")],
    timeoutMilliseconds: 50,
  });

  try {
    await assert.rejects(
      fastRunner.run({ prompt: "멈춤" }),
      (error: unknown) =>
        error instanceof CodexRunnerError && error.code === "timeout",
    );
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("cancels an active Codex process", async () => {
  const { root, runner } = fixture(`
    setTimeout(() => undefined, 60_000);
  `);
  const abortController = new AbortController();

  try {
    const running = runner.run({
      prompt: "취소",
      signal: abortController.signal,
    });
    setTimeout(() => abortController.abort(), 20);
    await assert.rejects(
      running,
      (error: unknown) =>
        error instanceof CodexRunnerError && error.code === "cancelled",
    );
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});
