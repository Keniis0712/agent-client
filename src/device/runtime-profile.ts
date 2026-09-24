import { createHash } from "node:crypto";
import type { RuntimeProfileInput } from "../protocol/types.js";

function stable(value: unknown): string {
  if (value === null || typeof value !== "object") return JSON.stringify(value);
  if (Array.isArray(value)) return `[${value.map(stable).join(",")}]`;
  return `{${Object.entries(value as Record<string, unknown>)
    .sort(([a], [b]) => a.localeCompare(b))
    .map(([key, item]) => `${JSON.stringify(key)}:${stable(item)}`)
    .join(",")}}`;
}

export function profileFingerprint(profile?: RuntimeProfileInput): string {
  if (!profile) return "claude:default";
  const keyFingerprint = createHash("sha256").update(profile.apiKey).digest("hex");
  return createHash("sha256")
    .update(stable({ agent: "claude", ...profile, apiKey: keyFingerprint }))
    .digest("hex");
}
