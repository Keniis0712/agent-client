import type { SessionStoreEntry } from "@anthropic-ai/claude-agent-sdk";
import type { Thread } from "../../generated/codex/v2/Thread.js";
import type { SessionHistory, SessionHistoryMessage } from "../protocol/types.js";

const INTERNAL_PROJECT_MESSAGE = "[PROJECT_AGENT_MESSAGE]";
const HIDDEN_NATIVE_USER_PREFIXES = [INTERNAL_PROJECT_MESSAGE, "<environment_context>", "<recommended_plugins>"];

function textContent(value: unknown): string {
  if (typeof value === "string") return value;
  if (!Array.isArray(value)) return "";
  return value
    .filter((block): block is { type: string; text: string } =>
      Boolean(block && typeof block === "object" && (block as any).type === "text" && typeof (block as any).text === "string"),
    )
    .map((block) => block.text)
    .join("\n");
}

function historyMessage(message: SessionHistoryMessage): SessionHistoryMessage {
  return message.role === "user" && HIDDEN_NATIVE_USER_PREFIXES.some((prefix) => message.content.trimStart().startsWith(prefix))
    ? { ...message, hidden: true }
    : message;
}

export function normalizeCodexRollout(jsonl: string): SessionHistory {
  const messages: SessionHistoryMessage[] = [];
  let currentTurnId: string | undefined;
  for (const line of jsonl.split(/\r?\n/)) {
    if (!line.trim()) continue;
    let entry: any;
    try {
      entry = JSON.parse(line);
    } catch {
      continue;
    }
    if (entry.type === "event_msg" && entry.payload?.type === "task_started") {
      currentTurnId = typeof entry.payload.turn_id === "string" ? entry.payload.turn_id : undefined;
      continue;
    }
    const payload = entry.type === "response_item" ? entry.payload : undefined;
    if (payload?.type !== "message" || (payload.role !== "user" && payload.role !== "assistant")) continue;
    const expectedBlock = payload.role === "user" ? "input_text" : "output_text";
    const content = Array.isArray(payload.content)
      ? payload.content
          .filter((block: any) => block?.type === expectedBlock && typeof block.text === "string")
          .map((block: any) => block.text)
          .join("\n")
      : "";
    if (!content) continue;
    messages.push(historyMessage({
      id: typeof payload.id === "string" ? payload.id : `rollout-${entry.ordinal ?? messages.length}`,
      role: payload.role,
      content,
      ...(currentTurnId ? { nativeTurnId: currentTurnId } : {}),
      ...(typeof entry.timestamp === "string" ? { createdAt: entry.timestamp } : {}),
    }));
  }
  return { source: "native", messages };
}

export function normalizeCodexHistory(thread: Thread): SessionHistory {
  const messages: SessionHistoryMessage[] = [];
  for (const turn of thread.turns) {
    const createdAt = turn.startedAt == null ? undefined : new Date(turn.startedAt * 1000).toISOString();
    for (const item of turn.items) {
      if (item.type === "userMessage") {
        const content = item.content
          .filter((input) => input.type === "text")
          .map((input) => input.text)
          .join("\n");
        if (content) messages.push(historyMessage({
          id: item.id,
          role: "user",
          content,
          nativeTurnId: turn.id,
          ...(createdAt ? { createdAt } : {}),
        }));
      } else if (item.type === "agentMessage" && item.text) {
        messages.push({
          id: item.id,
          role: "assistant",
          content: item.text,
          nativeTurnId: turn.id,
          ...(createdAt ? { createdAt } : {}),
        });
      }
    }
  }
  return { source: "native", messages };
}

export function normalizeClaudeHistory(entries: SessionStoreEntry[]): SessionHistory {
  const messages: SessionHistoryMessage[] = [];
  for (const entry of entries) {
    if (entry.type !== "user" && entry.type !== "assistant") continue;
    const nativeMessage = entry.message as { role?: unknown; content?: unknown } | undefined;
    if (!nativeMessage || nativeMessage.role !== entry.type) continue;
    const content = textContent(nativeMessage.content);
    if (!content) continue;
    const message: SessionHistoryMessage = {
      id: typeof entry.uuid === "string" ? entry.uuid : `${entry.type}-${messages.length}`,
      role: entry.type,
      content,
      ...(typeof entry.timestamp === "string" ? { createdAt: entry.timestamp } : {}),
    };
    messages.push(historyMessage(message));
  }
  return { source: "native", messages };
}
