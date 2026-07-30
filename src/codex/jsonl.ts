export interface CodexUsage {
  inputTokens?: number;
  cachedInputTokens?: number;
  outputTokens?: number;
}

export interface ParsedCodexOutput {
  threadId?: string;
  finalText?: string;
  usage?: CodexUsage;
  turnFailed: boolean;
}

interface JsonObject {
  [key: string]: unknown;
}

function isObject(value: unknown): value is JsonObject {
  return typeof value === "object" && value !== null;
}

function optionalNumber(value: unknown): number | undefined {
  return typeof value === "number" && Number.isFinite(value)
    ? value
    : undefined;
}

export class CodexJsonlParser {
  #buffer = "";
  #output: ParsedCodexOutput = { turnFailed: false };

  push(chunk: string): void {
    this.#buffer += chunk;
    let newlineIndex = this.#buffer.indexOf("\n");
    while (newlineIndex >= 0) {
      const line = this.#buffer.slice(0, newlineIndex);
      this.#buffer = this.#buffer.slice(newlineIndex + 1);
      this.#parseLine(line);
      newlineIndex = this.#buffer.indexOf("\n");
    }
  }

  finish(): ParsedCodexOutput {
    if (this.#buffer.trim()) {
      this.#parseLine(this.#buffer);
    }
    this.#buffer = "";
    return { ...this.#output };
  }

  #parseLine(line: string): void {
    if (!line.trim()) {
      return;
    }

    let event: unknown;
    try {
      event = JSON.parse(line);
    } catch {
      return;
    }
    if (!isObject(event) || typeof event.type !== "string") {
      return;
    }

    if (
      event.type === "thread.started" &&
      typeof event.thread_id === "string"
    ) {
      this.#output.threadId = event.thread_id;
      return;
    }

    if (event.type === "item.completed" && isObject(event.item)) {
      if (
        event.item.type === "agent_message" &&
        typeof event.item.text === "string"
      ) {
        this.#output.finalText = event.item.text;
      }
      return;
    }

    if (event.type === "turn.completed" && isObject(event.usage)) {
      const usage: CodexUsage = {};
      const inputTokens = optionalNumber(event.usage.input_tokens);
      const cachedInputTokens = optionalNumber(event.usage.cached_input_tokens);
      const outputTokens = optionalNumber(event.usage.output_tokens);
      if (inputTokens !== undefined) {
        usage.inputTokens = inputTokens;
      }
      if (cachedInputTokens !== undefined) {
        usage.cachedInputTokens = cachedInputTokens;
      }
      if (outputTokens !== undefined) {
        usage.outputTokens = outputTokens;
      }
      this.#output.usage = usage;
      return;
    }

    if (event.type === "turn.failed" || event.type === "error") {
      this.#output.turnFailed = true;
    }
  }
}
