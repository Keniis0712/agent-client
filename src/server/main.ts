import { resolve } from "node:path";
import { ControlServer } from "./control-server.js";

const server = new ControlServer({
  host: process.env.AGENT_SERVER_HOST ?? "0.0.0.0",
  port: Number(process.env.AGENT_SERVER_PORT ?? 8080),
  dataDir: resolve(process.env.AGENT_SERVER_DATA_DIR ?? ".data/server"),
});

server.start();

