import { createHash, randomUUID } from "node:crypto";
import { mkdir, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import type { RuntimeProfileInput } from "../protocol/types.js";
import { GatewayError } from "../shared/errors.js";

function stable(value: unknown): string {
  if (value === null || typeof value !== "object") return JSON.stringify(value);
  if (Array.isArray(value)) return `[${value.map(stable).join(",")}]`;
  return `{${Object.entries(value as Record<string, unknown>)
    .sort(([a], [b]) => a.localeCompare(b))
    .map(([key, item]) => `${JSON.stringify(key)}:${stable(item)}`)
    .join(",")}}`;
}

function quoteToml(value: string): string {
  return JSON.stringify(value);
}

export function profileFingerprint(agent: string, profile?: RuntimeProfileInput): string {
  if (!profile) return `${agent}:default`;
  const keyFingerprint = createHash("sha256").update(profile.apiKey).digest("hex");
  return createHash("sha256")
    .update(stable({ agent, ...profile, apiKey: keyFingerprint }))
    .digest("hex");
}

export interface MaterializedCodexProfile {
  profileName: string;
  profilePath: string;
  configOverrides: string[];
  env: NodeJS.ProcessEnv;
  cleanup(): Promise<void>;
}

export async function materializeCodexProfile(
  profileDir: string,
  profile: RuntimeProfileInput,
): Promise<MaterializedCodexProfile> {
  if ((profile.protocol ?? "responses") !== "responses") {
    throw new GatewayError(
      "RUNTIME_PROFILE_INVALID",
      "Codex custom providers only support the Responses wire API",
    );
  }

  await mkdir(profileDir, { recursive: true });
  const suffix = randomUUID().replaceAll("-", "");
  const profileName = `agw_${suffix}`;
  // Each profile has its own App Server process, so a stable provider id is safe
  // and lets thread/resume explicitly select the new runtime provider.
  const providerName = "gateway_runtime";
  const profilePath = join(profileDir, `${profileName}.config.toml`);
  const lines = [
    `model = ${quoteToml(profile.model)}`,
    `model_provider = ${quoteToml(providerName)}`,
  ];
  const configOverrides = [
    `model=${quoteToml(profile.model)}`,
    `model_provider=${quoteToml(providerName)}`,
  ];
  if (profile.reasoningEffort) {
    lines.push(`model_reasoning_effort = ${quoteToml(profile.reasoningEffort)}`);
    configOverrides.push(`model_reasoning_effort=${quoteToml(profile.reasoningEffort)}`);
  }
  lines.push(
    "",
    `[model_providers.${providerName}]`,
    `name = ${quoteToml(profile.modelProvider ?? "Agent Gateway Runtime")}`,
    `base_url = ${quoteToml(profile.baseUrl.replace(/\/$/, ""))}`,
    'env_key = "AGENT_RUNTIME_API_KEY"',
    'wire_api = "responses"',
  );
  configOverrides.push(
    `model_providers.${providerName}.name=${quoteToml(profile.modelProvider ?? "Agent Gateway Runtime")}`,
    `model_providers.${providerName}.base_url=${quoteToml(profile.baseUrl.replace(/\/$/, ""))}`,
    `model_providers.${providerName}.env_key="AGENT_RUNTIME_API_KEY"`,
    `model_providers.${providerName}.wire_api="responses"`,
  );

  const env: NodeJS.ProcessEnv = { ...process.env, AGENT_RUNTIME_API_KEY: profile.apiKey };
  for (const [name, value] of Object.entries(profile.extraHeaders ?? {})) {
    const envName = `AGENT_RUNTIME_HEADER_${createHash("sha256").update(name).digest("hex").slice(0, 12).toUpperCase()}`;
    env[envName] = value;
    lines.push(`env_http_headers.${quoteToml(name)} = ${quoteToml(envName)}`);
    configOverrides.push(
      `model_providers.${providerName}.env_http_headers.${quoteToml(name)}=${quoteToml(envName)}`,
    );
  }

  await writeFile(profilePath, `${lines.join("\n")}\n`, { encoding: "utf8", mode: 0o600 });
  return {
    profileName,
    profilePath,
    configOverrides,
    env,
    cleanup: async () => {
      await rm(profilePath, { force: true });
    },
  };
}
