import { DeviceDaemon } from "./daemon.js";
import { loadDeviceConfig } from "./config.js";
import { log } from "../shared/log.js";

const configPath = process.env.AGENT_DEVICE_CONFIG ?? "device.config.local.json";
const config = await loadDeviceConfig(configPath);
const daemon = new DeviceDaemon(config);

const shutdown = async () => {
  log("info", "Stopping device daemon");
  await daemon.stop();
  process.exit(0);
};

process.once("SIGINT", () => void shutdown());
process.once("SIGTERM", () => void shutdown());

await daemon.start();

