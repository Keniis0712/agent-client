import { z } from "zod";

export const runtimeProfileSchema = z.object({
  id: z.string().min(1).optional(),
  baseUrl: z.string().url(),
  apiKey: z.string().min(1),
  model: z.string().min(1),
  protocol: z.literal("anthropic").optional(),
  modelProvider: z.string().min(1).optional(),
  reasoningEffort: z.enum(["minimal", "low", "medium", "high", "xhigh"]).optional(),
  extraHeaders: z.record(z.string(), z.string()).optional(),
  options: z.record(z.string(), z.unknown()).optional(),
});

export const controlContextSchema = z
  .object({
    consoleBaseUrl: z.string().url(),
    role: z.enum(["orchestrator", "project"]),
    orchestratorSessionId: z.string().min(1),
    projectId: z.string().min(1).optional(),
    projectRunId: z.string().min(1).optional(),
  })
  .superRefine((value, ctx) => {
    if (value.role === "project" && (!value.projectId || !value.projectRunId)) {
      ctx.addIssue({
        code: "custom",
        message: "project role requires projectId and projectRunId",
      });
    }
  });

export const skillBundleSchema = z.object({
  id: z.string().min(1),
  version: z.string().min(1),
  sha256: z.string().min(1).optional(),
  files: z.record(z.string(), z.string()),
});

export const agentBootstrapSchema = z.object({
  instructionsVersion: z.string().min(1),
  instructions: z.string().min(1),
  skillBundles: z.array(skillBundleSchema).default([]),
});

export const permissionPolicySchema = z.object({
  mode: z.enum(["plan", "prompt", "accept_edits", "full"]),
  allowedTools: z.array(z.string()).optional(),
  disallowedTools: z.array(z.string()).optional(),
  approvalPolicy: z.string().optional(),
  sandboxMode: z.string().optional(),
});

export const createSessionSchema = z.object({
  sessionId: z.string().min(1).optional(),
  deviceId: z.string().min(1),
  agent: z.literal("claude"),
  workingDirectory: z.string().min(1).optional(),
  runtimeProfile: runtimeProfileSchema.optional(),
  controlContext: controlContextSchema.optional(),
  bootstrap: agentBootstrapSchema.optional(),
  prompt: z.string().optional(),
  permissionPolicy: permissionPolicySchema.optional(),
});

export const sessionCommandSchema = z.object({
  commandId: z.string().min(1),
  idempotencyKey: z.string().min(1),
  expectedRevision: z.number().int().nonnegative().optional(),
  type: z.enum([
    "message.send",
    "turn.interrupt",
    "approval.resolve",
    "model.change",
    "profile.change",
    "permission.change",
    "goal.set",
    "goal.get",
    "goal.clear",
    "session.compact",
    "session.close",
  ]),
  payload: z.unknown().default({}),
});
