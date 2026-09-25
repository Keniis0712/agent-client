import { createServer } from "node:http";

const port = Number(process.env.MOCK_ANTHROPIC_PORT ?? 9911);

const server = createServer((request, response) => {
  const chunks = [];
  request.on("data", (chunk) => chunks.push(chunk));
  request.on("end", () => {
    const body = chunks.length ? JSON.parse(Buffer.concat(chunks).toString("utf8")) : {};
    console.log(JSON.stringify({
      method: request.method,
      url: request.url,
      hasApiKey: Boolean(request.headers["x-api-key"] ?? request.headers.authorization),
      model: body.model,
      stream: body.stream,
    }));

    if (request.url?.includes("count_tokens")) {
      response.writeHead(200, { "content-type": "application/json" });
      response.end(JSON.stringify({ input_tokens: 1 }));
      return;
    }
    if (!request.url?.includes("messages")) {
      response.writeHead(404, { "content-type": "application/json" });
      response.end(JSON.stringify({ error: { type: "not_found_error", message: "Not found" } }));
      return;
    }
    if (!body.stream) {
      response.writeHead(200, { "content-type": "application/json" });
      response.end(JSON.stringify({
        id: "msg_gateway_mock",
        type: "message",
        role: "assistant",
        model: body.model ?? "mock-model",
        content: [{ type: "text", text: "CUSTOM_PROFILE_OK" }],
        stop_reason: "end_turn",
        stop_sequence: null,
        usage: { input_tokens: 1, output_tokens: 3 },
      }));
      return;
    }

    response.writeHead(200, {
      "content-type": "text/event-stream",
      "cache-control": "no-cache",
      connection: "keep-alive",
    });
    const events = [
      ["message_start", { type: "message_start", message: { id: "msg_gateway_mock", type: "message", role: "assistant", model: body.model ?? "mock-model", content: [], stop_reason: null, stop_sequence: null, usage: { input_tokens: 1, output_tokens: 0 } } }],
      ["content_block_start", { type: "content_block_start", index: 0, content_block: { type: "text", text: "" } }],
      ["content_block_delta", { type: "content_block_delta", index: 0, delta: { type: "text_delta", text: "CUSTOM_PROFILE_OK" } }],
      ["content_block_stop", { type: "content_block_stop", index: 0 }],
      ["message_delta", { type: "message_delta", delta: { stop_reason: "end_turn", stop_sequence: null }, usage: { output_tokens: 3 } }],
      ["message_stop", { type: "message_stop" }],
    ];
    for (const [event, data] of events) response.write(`event: ${event}\ndata: ${JSON.stringify(data)}\n\n`);
    response.end();
  });
});

server.listen(port, "127.0.0.1", () => console.log(JSON.stringify({ listening: port })));
