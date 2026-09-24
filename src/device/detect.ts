import { execFile } from "node:child_process";
import { promisify } from "node:util";
import type { AgentInfo } from "../protocol/types.js";
import { commandInvocation, resolveExecutable } from "../shared/executable.js";

const execFileAsync = promisify(execFile);

async function version(command: string): Promise<string | undefined> {
  try {
    const executable = await resolveExecutable(command);
    const invocation = commandInvocation(executable, ["--version"]);
    const result = await execFileAsync(invocation.command, invocation.args, {
      windowsHide: true,
      timeout: 5_000,
      windowsVerbatimArguments: invocation.windowsVerbatimArguments,
    });
    return result.stdout.trim() || result.stderr.trim();
  } catch {
    return undefined;
  }
}

export async function detectAgents(codexCommand: string): Promise<AgentInfo[]> {
  const [codexVersion, claudeVersion] = await Promise.all([version(codexCommand), version("claude")]);
  return [
    {
      id: "codex",
      available: Boolean(codexVersion),
      ...(codexVersion ? { version: codexVersion } : {}),
      capabilities: {
        streaming: true,
        approvals: true,
        clarifyQuestions: true,
        nativeGoal: true,
        steerCurrentTurn: true,
        queueMessages: true,
        interrupt: true,
        switchModelNextTurn: true,
        changePermissionLive: false,
        mutateToolInput: false,
        resumeSession: true,
      },
    },
    {
      id: "claude",
      available: Boolean(claudeVersion),
      ...(claudeVersion ? { version: claudeVersion } : {}),
      capabilities: {
        streaming: true,
        approvals: true,
        clarifyQuestions: true,
        nativeGoal: true,
        steerCurrentTurn: false,
        queueMessages: true,
        interrupt: true,
        switchModelNextTurn: true,
        changePermissionLive: true,
        mutateToolInput: true,
        resumeSession: true,
      },
    },
  ];
}
