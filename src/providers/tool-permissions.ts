import type { PermissionPolicy } from "../protocol/types.js";

function matches(rule: string, toolName: string): boolean {
  if (rule === "*") return true;
  if (rule.endsWith("*")) return toolName.startsWith(rule.slice(0, -1));
  return rule === toolName;
}

export function toolPermissionDecision(
  policy: PermissionPolicy,
  toolName: string,
): "allow" | "deny" | "prompt" {
  // APC is the platform control plane. Console-created agents must always be
  // able to use it without deadlocking behind that same approval channel.
  if (toolName.startsWith("mcp__agent_project_console__")) return "allow";
  if ((policy.disallowedTools ?? []).some((rule) => matches(rule, toolName))) return "deny";
  if ((policy.allowedTools ?? []).some((rule) => matches(rule, toolName))) return "allow";
  if (policy.mode === "full") return "allow";
  return "prompt";
}
