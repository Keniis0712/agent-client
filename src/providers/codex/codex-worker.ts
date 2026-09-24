import { spawn, type ChildProcessWithoutNullStreams } from "node:child_process";
import { JsonRpcPeer } from "./json-rpc-peer.js";
import { GatewayError } from "../../shared/errors.js";
import { commandInvocation, resolveExecutable } from "../../shared/executable.js";

export interface CodexWorkerOptions {
  id: string;
  command: string;
  cwd: string;
  codexHome: string;
  configOverrides?: string[];
  env?: NodeJS.ProcessEnv;
}

export class CodexWorker {
  readonly process: ChildProcessWithoutNullStreams;
  readonly rpc: JsonRpcPeer;

  private constructor(public readonly options: CodexWorkerOptions, process: ChildProcessWithoutNullStreams) {
    this.process = process;
    this.rpc = new JsonRpcPeer(process);
  }

  static async start(options: CodexWorkerOptions): Promise<CodexWorker> {
    // `codex app-server` intentionally rejects the global `--profile` flag.
    // Apply the materialized profile as equivalent, process-local config layers.
    const args = [
      "app-server",
      ...(options.configOverrides ?? []).flatMap((value) => ["-c", value]),
    ];
    const executable = await resolveExecutable(options.command);
    const invocation = commandInvocation(executable, args);
    const child = spawn(invocation.command, invocation.args, {
      cwd: options.cwd,
      env: { ...process.env, ...options.env, CODEX_HOME: options.codexHome },
      stdio: ["pipe", "pipe", "pipe"],
      windowsHide: true,
      windowsVerbatimArguments: invocation.windowsVerbatimArguments,
    });
    const worker = new CodexWorker(options, child);
    const startupError = new Promise<never>((_, reject) => {
      child.once("error", (error) =>
        reject(new GatewayError("RUNTIME_START_FAILED", error.message, true)),
      );
      child.once("exit", (code) =>
        reject(new GatewayError("RUNTIME_START_FAILED", `Codex exited during startup (${code})`, true)),
      );
    });
    await Promise.race([worker.rpc.initialize(), startupError]);
    return worker;
  }

  async close(): Promise<void> {
    if (this.process.exitCode !== null) return;
    this.process.kill();
    await Promise.race([
      new Promise<void>((resolve) => this.process.once("exit", () => resolve())),
      new Promise<void>((resolve) => setTimeout(resolve, 5_000)),
    ]);
    if (this.process.exitCode === null) this.process.kill("SIGKILL");
  }
}
