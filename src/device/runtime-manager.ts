import { homedir } from "node:os";
import { join, resolve } from "node:path";
import { mkdir, readdir, readFile, rm } from "node:fs/promises";
import type { AgentBootstrapInput, AgentKind, ControlContext, RuntimeProfileInput, SessionHistory, SessionRecord } from "../protocol/types.js";
import type { RuntimeHandle } from "../providers/types.js";
import { CodexWorker } from "../providers/codex/codex-worker.js";
import { CodexAdapter } from "../providers/codex/codex-adapter.js";
import { ClaudeAdapter } from "../providers/claude/claude-adapter.js";
import { SqliteClaudeSessionStore } from "../providers/claude/sqlite-session-store.js";
import { createId } from "../shared/ids.js";
import { GatewayError } from "../shared/errors.js";
import { materializeCodexProfile, profileFingerprint } from "./runtime-profile.js";
import { compileBootstrapInstructions, controlContextFingerprint, materializeSkillBundles } from "./runtime-bootstrap.js";
import { codexMcpOverrides, projectConsoleMcp } from "../mcp/runtime-config.js";
import { normalizeClaudeHistory, normalizeCodexRollout } from "../providers/history.js";

interface ManagedRuntime {
  key: string;
  id: string;
  fingerprint: string;
  instructions?: string;
  mcpServer?: RuntimeHandle["mcpServer"];
  adapter: CodexAdapter | ClaudeAdapter;
  refs: number;
  lastUsedAt: number;
  cleanup(): Promise<void>;
  timer?: NodeJS.Timeout;
}

export interface RuntimeManagerOptions {
  codexCommand: string;
  codexHome?: string;
  maxWorkers: number;
  workerIdleTimeoutSeconds: number;
  claudeSessionStorePath: string;
  runtimeRoot: string;
}

export class RuntimeManager {
  private readonly runtimes = new Map<string, ManagedRuntime>();
  private readonly codexHome: string;
  private readonly claudeSessionStore: SqliteClaudeSessionStore;

  constructor(private readonly options: RuntimeManagerOptions) {
    this.codexHome = options.codexHome ?? process.env.CODEX_HOME ?? join(homedir(), ".codex");
    this.claudeSessionStore = new SqliteClaudeSessionStore(options.claudeSessionStorePath);
  }

  async acquire(
    agent: AgentKind,
    cwd: string,
    profile?: RuntimeProfileInput,
    controlContext?: ControlContext,
    bootstrap?: AgentBootstrapInput,
  ): Promise<RuntimeHandle> {
    const fingerprint = profileFingerprint(agent, profile);
    const runtimeKey = `${fingerprint}:${controlContextFingerprint(controlContext)}`;
    let runtime = this.runtimes.get(runtimeKey);
    if (!runtime) {
      if (this.runtimes.size >= this.options.maxWorkers) {
        throw new GatewayError("RUNTIME_LIMIT_REACHED", "Maximum runtime worker count reached", true);
      }
      runtime = await this.createRuntime(agent, cwd, runtimeKey, fingerprint, profile, controlContext, bootstrap);
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
    if (session.agent === "claude") {
      return normalizeClaudeHistory(await this.claudeSessionStore.loadSessionEntries(session.nativeThreadId));
    }
    const path = await this.findCodexRollout(session.nativeThreadId);
    if (!path) throw new GatewayError("NATIVE_HISTORY_NOT_FOUND", `Codex rollout ${session.nativeThreadId} was not found`);
    return normalizeCodexRollout(await readFile(path, "utf8"));
  }

  private async findCodexRollout(threadId: string): Promise<string | undefined> {
    const visit = async (directory: string): Promise<string | undefined> => {
      let entries;
      try {
        entries = await readdir(directory, { withFileTypes: true });
      } catch {
        return undefined;
      }
      for (const entry of entries) {
        const path = join(directory, entry.name);
        if (entry.isFile() && entry.name.endsWith(`${threadId}.jsonl`)) return path;
      }
      for (const entry of entries) {
        if (!entry.isDirectory()) continue;
        const found = await visit(join(directory, entry.name));
        if (found) return found;
      }
      return undefined;
    };
    return (await visit(join(this.codexHome, "sessions")))
      ?? (await visit(join(this.codexHome, "archived_sessions")));
  }

  private async createRuntime(
    agent: AgentKind,
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
    if (agent === "codex") {
      const materialized = profile
        ? await materializeCodexProfile(join(runtimeDir, "profile"), profile)
        : undefined;
      try {
        const worker = await CodexWorker.start({
          id,
          command: this.options.codexCommand,
          cwd,
          codexHome: this.codexHome,
          configOverrides: [
            ...(materialized?.configOverrides ?? []),
            ...codexMcpOverrides(mcpServer),
          ],
          ...(materialized ? { env: materialized.env } : {}),
        });
        return {
          key,
          id,
          fingerprint,
          ...(instructions ? { instructions } : {}),
          ...(mcpServer ? { mcpServer } : {}),
          adapter: new CodexAdapter(worker, instructions, mcpServer),
          refs: 0,
          lastUsedAt: Date.now(),
          cleanup: async () => {
            await worker.close();
            await materialized?.cleanup();
            await rm(runtimeDir, { recursive: true, force: true });
          },
        };
      } catch (error) {
        await materialized?.cleanup();
        await rm(runtimeDir, { recursive: true, force: true });
        throw error;
      }
    }

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
