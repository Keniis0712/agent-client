import { createHash } from "node:crypto";
import { mkdir, writeFile } from "node:fs/promises";
import { dirname, join, normalize, relative, resolve } from "node:path";
import type { AgentBootstrapInput, ControlContext } from "../protocol/types.js";
import { GatewayError } from "../shared/errors.js";

function safeSegment(value: string): string {
  const sanitized = value.replace(/[^a-zA-Z0-9._-]+/g, "_");
  if (!sanitized || sanitized === "." || sanitized === "..") {
    throw new GatewayError("BOOTSTRAP_INVALID", `Invalid bundle path segment: ${value}`);
  }
  return sanitized;
}

function safeFile(root: string, value: string): string {
  const candidate = resolve(root, normalize(value));
  const rel = relative(root, candidate);
  if (!rel || rel.startsWith("..") || rel.includes(":") || rel.startsWith("\\")) {
    throw new GatewayError("BOOTSTRAP_INVALID", `Invalid skill file path: ${value}`);
  }
  return candidate;
}

export function controlContextFingerprint(context?: ControlContext): string {
  if (!context) return "unmanaged";
  return createHash("sha256")
    .update(JSON.stringify({
      consoleBaseUrl: context.consoleBaseUrl.replace(/\/$/, ""),
      role: context.role,
      orchestratorSessionId: context.orchestratorSessionId,
      projectId: context.projectId ?? "",
      projectRunId: context.projectRunId ?? "",
    }))
    .digest("hex");
}

export function compileBootstrapInstructions(
  bootstrap?: AgentBootstrapInput,
  context?: ControlContext,
): string | undefined {
  if (!bootstrap && !context) return undefined;
  const sections: string[] = [];
  if (context) {
    sections.push([
      "# Agent control context",
      `Role: ${context.role}`,
      `Orchestrator session: ${context.orchestratorSessionId}`,
      ...(context.projectId ? [`Project: ${context.projectId}`] : []),
      ...(context.projectRunId ? [`Project run: ${context.projectRunId}`] : []),
      "Use the injected Agent Project Console MCP tools for all control-plane communication.",
    ].join("\n"));
  }
  if (bootstrap?.instructions) {
    sections.push(`# Role contract (${bootstrap.instructionsVersion})\n${bootstrap.instructions}`);
  }
  for (const bundle of bootstrap?.skillBundles ?? []) {
    const files = Object.entries(bundle.files)
      .sort(([a], [b]) => a.localeCompare(b))
      .map(([name, content]) => `## ${name}\n${content}`)
      .join("\n\n");
    sections.push(`# Skill bundle: ${bundle.id}@${bundle.version}\n${files}`);
  }
  return sections.join("\n\n");
}

export async function materializeSkillBundles(
  runtimeDir: string,
  bootstrap?: AgentBootstrapInput,
): Promise<void> {
  if (!bootstrap?.skillBundles?.length) return;
  const skillsRoot = join(runtimeDir, "skills");
  for (const bundle of bootstrap.skillBundles) {
    const bundleRoot = join(skillsRoot, `${safeSegment(bundle.id)}@${safeSegment(bundle.version)}`);
    for (const [name, content] of Object.entries(bundle.files)) {
      const target = safeFile(bundleRoot, name);
      await mkdir(dirname(target), { recursive: true });
      await writeFile(target, content, { encoding: "utf8", mode: 0o600 });
    }
  }
}

