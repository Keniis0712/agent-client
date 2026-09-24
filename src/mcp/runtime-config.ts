import { fileURLToPath } from "node:url";
import type { ControlContext } from "../protocol/types.js";

export interface RuntimeMcpServer {
  command: string;
  args: string[];
  env: Record<string, string>;
}

export function projectConsoleMcp(context?: ControlContext): RuntimeMcpServer | undefined {
  if (!context) return undefined;
  const bridgePath = fileURLToPath(new URL("./bridge.js", import.meta.url));
  const env: Record<string, string> = {
    APC_BASE_URL: context.consoleBaseUrl.replace(/\/$/, ""),
    APC_AGENT_ROLE: context.role,
    APC_MAIN_SESSION_ID: context.orchestratorSessionId,
  };
  if (context.projectId) env.APC_PROJECT_ID = context.projectId;
  if (context.projectRunId) env.APC_PROJECT_RUN_ID = context.projectRunId;
  return { command: process.execPath, args: [bridgePath], env };
}

function quote(value: string): string {
  return JSON.stringify(value);
}

export function codexMcpOverrides(server?: RuntimeMcpServer): string[] {
  if (!server) return [];
  const prefix = "mcp_servers.agent_project_console";
  return [
    `${prefix}.command=${quote(server.command)}`,
    `${prefix}.args=[${server.args.map(quote).join(",")}]`,
    ...Object.entries(server.env).map(([key, value]) => `${prefix}.env.${key}=${quote(value)}`),
  ];
}

