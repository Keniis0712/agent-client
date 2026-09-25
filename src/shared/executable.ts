import { access } from "node:fs/promises";
import { delimiter, extname, isAbsolute, join } from "node:path";

const windowsExtensions = [".exe", ".com", ".cmd", ".bat", ".ps1", ""];

export async function resolveExecutable(command: string): Promise<string> {
  if (process.platform !== "win32") return command;
  const hasPath = isAbsolute(command) || command.includes("/") || command.includes("\\");
  const directories = hasPath ? [""] : (process.env.PATH ?? "").split(delimiter).filter(Boolean);
  const extensions = extname(command) ? [""] : windowsExtensions;
  for (const directory of directories) {
    for (const extension of extensions) {
      const candidate = directory ? join(directory, `${command}${extension}`) : `${command}${extension}`;
      try {
        await access(candidate);
        return candidate;
      } catch {}
    }
  }
  return command;
}

export function commandInvocation(
  executable: string,
  args: string[],
): { command: string; args: string[]; windowsVerbatimArguments?: boolean } {
  if (process.platform !== "win32") return { command: executable, args };
  if (/\.ps1$/i.test(executable)) {
    return {
      command: "powershell.exe",
      args: ["-NoProfile", "-NonInteractive", "-ExecutionPolicy", "Bypass", "-File", executable, ...args],
    };
  }
  if (/\.(?:cmd|bat)$/i.test(executable)) {
    const quote = (value: string) => `"${value.replaceAll("%", "%%").replaceAll('"', '""')}"`;
    const commandLine = `call ${[quote(executable), ...args.map(quote)].join(" ")}`;
    return {
      command: process.env.ComSpec ?? "cmd.exe",
      args: ["/d", "/s", "/c", commandLine],
      windowsVerbatimArguments: true,
    };
  }
  return { command: executable, args };
}
