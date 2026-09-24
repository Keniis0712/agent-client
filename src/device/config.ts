import { readFile } from "node:fs/promises";
import { resolve } from "node:path";
import { z } from "zod";

const configSchema = z.object({
  device: z.object({ id: z.string().min(1), name: z.string().min(1) }),
  controlServerUrl: z.string().url(),
  localApi: z
    .object({ host: z.string().default("127.0.0.1"), port: z.number().int().positive().default(9700) })
    .default({ host: "127.0.0.1", port: 9700 }),
  dataDir: z.string().default(".data/device"),
  workspaces: z.array(
    z.object({ id: z.string().min(1), name: z.string().min(1), path: z.string().min(1) }),
  ),
  runtime: z
    .object({
      maxWorkers: z.number().int().positive().default(8),
      workerIdleTimeoutSeconds: z.number().int().positive().default(1800),
    })
    .default({ maxWorkers: 8, workerIdleTimeoutSeconds: 1800 }),
});

export type DeviceConfig = z.infer<typeof configSchema>;

export async function loadDeviceConfig(path: string): Promise<DeviceConfig> {
  const absolute = resolve(path);
  const data = JSON.parse(await readFile(absolute, "utf8"));
  const config = configSchema.parse(data);
  return {
    ...config,
    dataDir: resolve(config.dataDir),
    workspaces: config.workspaces.map((workspace) => ({ ...workspace, path: resolve(workspace.path) })),
  };
}
