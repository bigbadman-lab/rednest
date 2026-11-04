import { describe, expect, test } from "bun:test";
import { createLlmClient, LlmError, LlmQuotaError, modelSupportsReasoningEffort, type ChatDelta } from "../src/llm";
import { mockEndpoint, sse, textReply } from "./helpers";

const endpoint = mockEndpoint();
const ask = { role: "hunt" as const, messages: [{ role: "user" as const, content: "hi" }] };

describe("chat", () => {
  test("assembles content, usage and a replayable message", async () => {
    endpoint.respond(() => sse(textReply("hello")));
    const result = await endpoint.client().chat(ask);

    expect(result).toMatchObject({ content: "hello", finishReason: "stop" });
    expect(result.usage).toEqual({ inputTokens: 10, cachedTokens: 8, outputTokens: 2, reasoningTokens: 0 });
    expect(result.message).toEqual({ role: "assistant", content: "hello" });
  });

  test("sends the model, auth and options", async () => {
    endpoint.respond(() => sse(textReply("ok")));
    await endpoint.client().chat({ ...ask, role: "structure", maxTokens: 50 });

    const [sent] = endpoint.requests;
    expect(sent!.headers.get("authorization")).toBe("Bearer test-key");
    expect(sent!.body).toMatchObject({ model: "model-a", max_tokens: 50, stream: true });
    expect(sent!.body).not.toHaveProperty("reasoning_effort");
  });

  test("sends no sampling params by default; a request can set temperature", async () => {
    endpoint.respond(() => sse(textReply("ok")), () => sse(textReply("ok")));
    await endpoint.client().chat(ask);
    expect(endpoint.requests[0]!.body).not.toHaveProperty("temperature");
    expect(endpoint.requests[0]!.body).not.toHaveProperty("seed");
    await endpoint.client().chat({ ...ask, temperature: 0.9 });
    expect(endpoint.requests[1]!.body).toMatchObject({ temperature: 0.9 });
  });

  test("reasons for hunt and skeptic unless overridden", async () => {
    endpoint.respond(...Array.from({ length: 3 }, () => () => sse(textReply("ok"))));
    const client = endpoint.client();
    await client.chat({ ...ask, role: "skeptic" });
    await client.chat({ ...ask, role: "hunt", reasoningEffort: null });
    await client.chat({ ...ask, role: "recon", reasoningEffort: "low" });

    expect(endpoint.requests.map((request) => request.body.reasoning_effort)).toEqual(["high", undefined, "low"]);
  });

  test("omits reasoning_effort for GPT-4.1, including explicit overrides", async () => {
    endpoint.respond(...Array.from({ length: 4 }, () => () => sse(textReply("ok"))));
    const gpt41 = createLlmClient({ ...endpoint.config, model: "gpt-4.1" }, { retryBaseMs: 1 });
    await gpt41.chat(ask);
    await gpt41.chat({ ...ask, role: "skeptic", reasoningEffort: "high" });

    const mini = createLlmClient({ ...endpoint.config, model: "openai/gpt-4.1-mini-2025-04-14" }, { retryBaseMs: 1 });
    await mini.chat(ask);

    const perRole = createLlmClient(
      { ...endpoint.config, model: "model-a", models: { recon: "model-a", hunt: "gpt-4.1-nano", skeptic: "model-a", structure: "model-a" } },
      { retryBaseMs: 1 },
    );
    await perRole.chat(ask);

    expect(endpoint.requests.map((request) => request.body.reasoning_effort)).toEqual([undefined, undefined, undefined, undefined]);
    expect(endpoint.requests.map((request) => request.body.model)).toEqual([
      "gpt-4.1",
      "gpt-4.1",
      "openai/gpt-4.1-mini-2025-04-14",
      "gpt-4.1-nano",
    ]);
  });

  test("keeps reasoning_effort for reasoning-capable and other compatible models", async () => {
    endpoint.respond(...Array.from({ length: 3 }, () => () => sse(textReply("ok"))));
    for (const model of ["o3", "o4-mini", "abliterated-hunt"]) {
      await createLlmClient({ ...endpoint.config, model }, { retryBaseMs: 1 }).chat(ask);
    }
    expect(endpoint.requests.map((request) => request.body.reasoning_effort)).toEqual(["high", "high", "high"]);
  });

  test("assembles tool calls streamed across chunks", async () => {
    endpoint.respond(() =>
      sse([
        { choices: [{ delta: { tool_calls: [{ index: 0, id: "c1", function: { name: "read_file", arguments: '{"pa' } }] } }] },
        { choices: [{ delta: { tool_calls: [{ index: 0, function: { arguments: 'th":"a.ts"}' } }] } }] },
        { choices: [{ delta: { tool_calls: [{ index: 1, function: { name: "search", arguments: "{}" } }] } }] },
        { choices: [{ delta: {}, finish_reason: "tool_calls" }] },
      ]),
    );
    const result = await endpoint.client().chat(ask);

    expect(result.finishReason).toBe("tool_calls");
    expect(result.toolCalls).toEqual([
      { id: "c1", type: "function", function: { name: "read_file", arguments: '{"path":"a.ts"}' } },
      { id: "call_1", type: "function", function: { name: "search", arguments: "{}" } },
    ]);
  });

  test("keeps reasoning in the message while a tool loop is in progress", async () => {
    endpoint.respond(() =>
      sse([
        { choices: [{ delta: { reasoning_content: "need the file" } }] },
        { choices: [{ delta: { tool_calls: [{ index: 0, id: "c1", function: { name: "read_file", arguments: "{}" } }] } }] },
        { choices: [{ delta: {}, finish_reason: "tool_calls" }] },
      ]),
    );
    const { message } = await endpoint.client().chat(ask);

    expect(message).toEqual({
      role: "assistant",
      content: null,
      tool_calls: [{ id: "c1", type: "function", function: { name: "read_file", arguments: "{}" } }],
      reasoning_content: "need the file",
    });
  });

  test("streams content and reasoning deltas", async () => {
    endpoint.respond(() =>
      sse([
        { choices: [{ delta: { reasoning_content: "think" } }] },
        { choices: [{ delta: { content: "an" } }] },
        { choices: [{ delta: { content: "swer" }, finish_reason: "stop" }] },
      ]),
    );
    const deltas: ChatDelta[] = [];
    const result = await endpoint.client().chat(ask, (delta) => deltas.push(delta));

    expect(deltas).toEqual([
      { type: "reasoning", text: "think" },
      { type: "content", text: "an" },
      { type: "content", text: "swer" },
    ]);
    expect(result).toMatchObject({ content: "answer", reasoning: "think" });
  });
});

describe("failures", () => {
  test("retries 429 honouring retry-after, then succeeds", async () => {
    endpoint.respond(
      () => new Response("slow down", { status: 429, headers: { "retry-after-ms": "5" } }),
      () => sse(textReply("ok")),
    );
    const result = await endpoint.client().chat(ask);
    expect(result.content).toBe("ok");
    expect(endpoint.requests).toHaveLength(2);
  });

  test("retries 429 using try-again hints from the response body", async () => {
    endpoint.respond(
      () =>
        new Response(
          JSON.stringify({
            error: {
              message: "Rate limit reached for gpt-4.1 on tokens per min (TPM): Limit 450000. Please try again in 20ms.",
            },
          }),
          { status: 429 },
        ),
      () => sse(textReply("ok")),
    );
    const retries: Array<{ reason: string; delayMs: number }> = [];
    const result = await endpoint.client({ retryBaseMs: 1, retryMaxMs: 50 }).chat(ask, undefined, (info) => retries.push(info));
    expect(result.content).toBe("ok");
    expect(endpoint.requests).toHaveLength(2);
    expect(retries[0]).toMatchObject({ reason: "rate_limit" });
    expect(retries[0]!.delayMs).toBeGreaterThanOrEqual(20);
  });

  test("exhausts the retry budget instead of looping forever on 429", async () => {
    endpoint.respond(...Array.from({ length: 20 }, () => () => new Response("slow down", { status: 429, headers: { "retry-after-ms": "30" } })));
    const error = await endpoint.client({ maxAttempts: 2, rateLimitExtraAttempts: 2, retryBudgetMs: 40, retryMaxMs: 30 }).chat(ask).catch((e: unknown) => e);
    expect(error).toBeInstanceOf(LlmError);
    expect((error as LlmError).status).toBe(429);
    expect(endpoint.requests.length).toBeGreaterThan(1);
    expect(endpoint.requests.length).toBeLessThan(20);
  });

  test("retries 5xx and truncated streams", async () => {
    endpoint.respond(
      () => new Response("down", { status: 503 }),
      () => sse([{ choices: [{ delta: { content: "partial" } }] }], { done: false }),
      () => sse(textReply("ok")),
    );
    expect((await endpoint.client().chat(ask)).content).toBe("ok");
    expect(endpoint.requests).toHaveLength(3);
  });

  test("gives up after maxAttempts", async () => {
    endpoint.respond(...Array.from({ length: 3 }, () => () => new Response("down", { status: 500 })));
    const error = await endpoint.client({ maxAttempts: 3 }).chat(ask).catch((e: unknown) => e);
    expect(error).toBeInstanceOf(LlmError);
    expect((error as LlmError).status).toBe(500);
    expect(endpoint.requests).toHaveLength(3);
  });

  test("does not retry other client errors", async () => {
    endpoint.respond(() => Response.json({ error: { message: "bad model" } }, { status: 400 }));
    const error = await endpoint.client().chat(ask).catch((e: unknown) => e);
    expect((error as LlmError).message).toContain("bad model");
    expect(endpoint.requests).toHaveLength(1);
  });

  test.each([
    [402, "payment required"],
    [429, '{"error":{"code":"insufficient_quota"}}'],
  ])("treats %i quota responses as LlmQuotaError without retrying", async (status, body) => {
    endpoint.respond(() => new Response(body, { status }));
    const error = await endpoint.client().chat(ask).catch((e: unknown) => e);
    expect(error).toBeInstanceOf(LlmQuotaError);
    expect(endpoint.requests).toHaveLength(1);
  });

  test("retries a stalled stream after the idle timeout", async () => {
    endpoint.respond(
      () => new Response(new ReadableStream({ start: () => {} }), { headers: { "content-type": "text/event-stream" } }),
      () => sse(textReply("ok")),
    );
    const result = await endpoint.client({ idleTimeoutMs: 50 }).chat(ask);
    expect(result.content).toBe("ok");
  });

  test("does not retry once deltas have been delivered", async () => {
    endpoint.respond(
      () => sse([{ choices: [{ delta: { content: "partial" } }] }], { done: false }),
      () => sse(textReply("ok")),
    );
    const error = await endpoint.client().chat(ask, () => {}).catch((e: unknown) => e);
    expect((error as LlmError).message).toContain("ended before completion");
    expect(endpoint.requests).toHaveLength(1);
  });

  test("propagates caller aborts without retrying", async () => {
    endpoint.respond(() => new Response(new ReadableStream({ start: () => {} })));
    const controller = new AbortController();
    setTimeout(() => controller.abort(new Error("cancelled")), 20);
    const error = await endpoint.client().chat({ ...ask, signal: controller.signal }).catch((e: unknown) => e);
    expect((error as Error).message).toBe("cancelled");
    expect(endpoint.requests).toHaveLength(1);
  });

  test("surfaces errors sent inside the stream", async () => {
    endpoint.respond(...Array.from({ length: 2 }, () => () => sse([{ error: { message: "overloaded" } }])));
    const error = await endpoint.client({ maxAttempts: 2 }).chat(ask).catch((e: unknown) => e);
    expect((error as LlmError).message).toContain("overloaded");
  });
});

describe("modelSupportsReasoningEffort", () => {
  test.each([
    ["gpt-4.1", false],
    ["GPT-4.1", false],
    ["gpt-4.1-mini", false],
    ["gpt-4.1-nano", false],
    ["gpt-4.1-2025-04-14", false],
    ["openai/gpt-4.1-mini-2025-04-14", false],
    ["o3", true],
    ["o4-mini", true],
    ["model-a", true],
    ["gpt-4o", true],
  ])("%s → %s", (model, supported) => {
    expect(modelSupportsReasoningEffort(model)).toBe(supported);
  });
});

describe("timeouts", () => {
  test("gives up on a response that streams for too long, and retries", async () => {
    let calls = 0;
    endpoint.respond(
      () => {
        calls++;
        // Keeps sending bytes: the idle timer never fires, the overall limit does.
        const stream = new ReadableStream<Uint8Array>({
          async pull(controller) {
            await Bun.sleep(5);
            controller.enqueue(new TextEncoder().encode(": keep-alive\n\n"));
          },
        });
        return new Response(stream, { headers: { "content-type": "text/event-stream" } });
      },
      () => sse(textReply("ok")),
    );
    const result = await endpoint.client({ requestTimeoutMs: 50, idleTimeoutMs: 1_000 }).chat(ask);
    expect(result.content).toBe("ok");
    expect(result.retries).toBe(1);
    expect(calls).toBe(1);
  });
});
