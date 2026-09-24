import { createHash } from "node:crypto";
import { mkdir, writeFile } from "node:fs/promises";
import { dirname, join, normalize, relative, resolve } from "node:path";
import type { AgentBootstrapInput, ControlContext } from "../protocol/types.js";
import { GatewayError } from "../shared/errors.js";

const RUNTIME_PLUGIN_NAME = "agent-project-console-runtime";

export interface MaterializedSkillPlugin {
  path: string;
  skillNames: string[];
}

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

export function bootstrapFingerprint(bootstrap?: AgentBootstrapInput): string {
  if (!bootstrap) return "no-bootstrap";
  const normalized = {
    instructionsVersion: bootstrap.instructionsVersion,
    instructions: bootstrap.instructions,
    skillBundles: (bootstrap.skillBundles ?? []).map((bundle) => ({
      id: bundle.id,
      version: bundle.version,
      sha256: bundle.sha256 ?? "",
      files: Object.entries(bundle.files).sort(([a], [b]) => a.localeCompare(b)),
    })),
  };
  return createHash("sha256").update(JSON.stringify(normalized)).digest("hex");
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
  return sections.join("\n\n");
}

export async function materializeSkillBundles(
  runtimeDir: string,
  bootstrap?: AgentBootstrapInput,
): Promise<MaterializedSkillPlugin | undefined> {
  if (!bootstrap?.skillBundles?.length) return undefined;
  const pluginRoot = join(runtimeDir, "claude-plugin");
  const skillsRoot = join(pluginRoot, "skills");
  await mkdir(join(pluginRoot, ".claude-plugin"), { recursive: true });
  await writeFile(
    join(pluginRoot, ".claude-plugin", "plugin.json"),
    `${JSON.stringify({
      name: RUNTIME_PLUGIN_NAME,
      version: "1.0.0",
      description: "Runtime skills supplied by Agent Project Console",
    }, null, 2)}\n`,
    { encoding: "utf8", mode: 0o600 },
  );
  const skillNames: string[] = [];
  const directories = new Set<string>();
  for (const bundle of bootstrap.skillBundles) {
    const skillId = safeSegment(bundle.id);
    if (directories.has(skillId)) {
      throw new GatewayError("BOOTSTRAP_INVALID", `Duplicate skill id after normalization: ${bundle.id}`);
    }
    directories.add(skillId);
    const manifest = bundle.files["SKILL.md"];
    if (!manifest) {
      throw new GatewayError("BOOTSTRAP_INVALID", `Skill bundle ${bundle.id} is missing SKILL.md`);
    }
    const bundleRoot = join(skillsRoot, skillId);
    for (const [name, content] of Object.entries(bundle.files)) {
      const target = safeFile(bundleRoot, name);
      await mkdir(dirname(target), { recursive: true });
      const value = name === "SKILL.md" && !content.trimStart().startsWith("---")
        ? `---\nname: ${skillId}\ndescription: ${JSON.stringify(`Workflow instructions for ${bundle.id}`)}\n---\n\n${content}`
        : content;
      await writeFile(target, value, { encoding: "utf8", mode: 0o600 });
    }
    skillNames.push(`${RUNTIME_PLUGIN_NAME}:${skillId}`);
  }
  return { path: pluginRoot, skillNames };
}
