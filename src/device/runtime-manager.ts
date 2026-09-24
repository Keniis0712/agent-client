import { join, resolve } from "node:path";
import { mkdir, rm } from "node:fs/promises";
import type { AgentBootstrapInput, ControlContext, RuntimeProfileInput, SessionHistory, SessionRecord } from "../protocol/types.js";
import type { RuntimeHandle } from "../providers/types.js";
import { ClaudeAdapter } from "../providers/claude/claude-adapter.js";
import { SqliteClaudeSessionStore } from "../providers/claude/sqlite-session-store.js";
import { createId } from "../shared/ids.js";
import { GatewayError } from "../shared/errors.js";
import { profileFingerprint } from "./runtime-profile.js";
import { compileBootstrapInstructions, controlContextFingerprint, materializeSkillBundles } from "./runtime-bootstrap.js";
import { projectConsoleMcp } from "../mcp/runtime-config.js";
import { normalizeClaudeHistory } from "../providers/history.js";

interface ManagedRuntime {
  key: string;
  id: string;
  fingerprint: string;
  instructions?: string;
  mcpServer?: RuntimeHandle["mcpServer"];
  adapter: ClaudeAdapter;
  refs: number;
  lastUsedAt: number;
  cleanup(): Promise<void>;
  timer?: NodeJS.Timeout;
}

export interface RuntimeManagerOptions {
  maxWorkers: number;
  workerIdleTimeoutSeconds: number;
  claudeSessionStorePath: string;
  runtimeRoot: string;
}

export class RuntimeManager {
  private readonly runtimes = new Map<string, ManagedRuntime>();
  private readonly claudeSessionStore: SqliteClaudeSessionStore;

  constructor(private readonly options: RuntimeManagerOptions) {
    this.claudeSessionStore = new SqliteClaudeSessionStore(options.claudeSessionStorePath);
  }

  async acquire(
    cwd: string,
    profile?: RuntimeProfileInput,
    controlContext?: ControlContext,
    bootstrap?: AgentBootstrapInput,
  ): Promise<RuntimeHandle> {
    const fingerprint = profileFingerprint(profile);
    const runtimeKey = `${fingerprint}:${controlContextFingerprint(controlContext)}`;
    let runtime = this.runtimes.get(runtimeKey);
    if (!runtime) {
      if (this.runtimes.size >= this.options.maxWorkers) {
        throw new GatewayError("RUNTIME_LIMIT_REACHED", "Maximum runtime worker count reached", true);
      }
      runtime = await this.createRuntime(cwd, runtimeKey, fingerprint, profile, controlContext, bootstrap);
      this.runtimes.set(runtimeKey, runtime);
    }
    if (runtime.timer) clearTimeout(runtime.timer);
    runtime.timer = undefined;
    runtime.refs++;
    runtime.lastUsedAt = Date.now();
    let released = false;
    return {
      id: runtime.id,
      fingerprint,
      ...(profile ? { profile } : {}),
      ...(runtime.instructions ? { instructions: runtime.instructions } : {}),
      ...(runtime.mcpServer ? { mcpServer: runtime.mcpServer } : {}),
      adapter: runtime.adapter,
      release: async () => {
        if (released) return;
        released = true;
        runtime!.refs--;
        runtime!.lastUsedAt = Date.now();
        if (runtime!.refs === 0) this.scheduleCleanup(runtime!);
      },
    };
  }

  async close(): Promise<void> {
    const runtimes = [...this.runtimes.values()];
    this.runtimes.clear();
    await Promise.allSettled(runtimes.map((runtime) => runtime.cleanup()));
    this.claudeSessionStore.close();
  }

  async getNativeHistory(session: SessionRecord): Promise<SessionHistory> {
    if (!session.nativeThreadId) throw new GatewayError("NATIVE_SESSION_NOT_READY", "Session has no native thread id");
    return normalizeClaudeHistory(await this.claudeSessionStore.loadSessionEntries(session.nativeThreadId));
  }

  private async createRuntime(
    cwd: string,
    key: string,
    fingerprint: string,
    profile?: RuntimeProfileInput,
    controlContext?: ControlContext,
    bootstrap?: AgentBootstrapInput,
  ): Promise<ManagedRuntime> {
    const id = createId("run");
    const runtimeDir = resolve(this.options.runtimeRoot, id);
    await mkdir(runtimeDir, { recursive: true });
    await materializeSkillBundles(runtimeDir, bootstrap);
    const instructions = compileBootstrapInstructions(bootstrap, controlContext);
    const mcpServer = projectConsoleMcp(controlContext);
    const claudeProfileConfigDir = join(runtimeDir, "claude-config");
    await mkdir(claudeProfileConfigDir, { recursive: true });
    const adapter = new ClaudeAdapter(
      id,
      cwd,
      profile,
      this.claudeSessionStore,
      claudeProfileConfigDir,
      instructions,
      mcpServer,
    );
    return {
      key,
      id,
      fingerprint,
      ...(instructions ? { instructions } : {}),
      ...(mcpServer ? { mcpServer } : {}),
      adapter,
      refs: 0,
      lastUsedAt: Date.now(),
      cleanup: async () => {
        await adapter.close();
        await rm(runtimeDir, { recursive: true, force: true });
      },
    };
  }

  private scheduleCleanup(runtime: ManagedRuntime): void {
    runtime.timer = setTimeout(async () => {
      if (runtime.refs !== 0) return;
      this.runtimes.delete(runtime.key);
      await runtime.cleanup();
    }, this.options.workerIdleTimeoutSeconds * 1000);
    runtime.timer.unref();
  }
}
