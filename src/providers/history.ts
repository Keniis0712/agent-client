import type { SessionStoreEntry } from "@anthropic-ai/claude-agent-sdk";
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
