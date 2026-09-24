export type LogLevel = "debug" | "info" | "warn" | "error";

export function log(level: LogLevel, message: string, fields: Record<string, unknown> = {}): void {
  const entry = JSON.stringify({ level, message, time: new Date().toISOString(), ...fields });
  if (level === "error") process.stderr.write(`${entry}\n`);
  else process.stdout.write(`${entry}\n`);
}

