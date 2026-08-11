import { execFile } from "node:child_process";
import { promisify } from "node:util";

const execFileAsync = promisify(execFile);

function validProfileId(value) {
  return typeof value === "string"
    && value.length > 0
    && value.length <= 128
    && /^[a-z0-9._-]+$/i.test(value);
}

export function createKeychainStore({
  service = "com.chuspeeism.codex-taskboard.team-token",
  runner = (command, args, options) => execFileAsync(command, args, options),
} = {}) {
  async function run(args, options = {}) {
    return runner("/usr/bin/security", args, { encoding: "utf8", ...options });
  }
  function account(profileId) {
    if (!validProfileId(profileId)) throw new Error("Invalid Team Server profile id");
    return profileId;
  }
  return {
    async set(profileId, token) {
      const value = typeof token === "string" ? token.trim() : "";
      if (!value || value.length > 4096 || /[\u0000\r\n]/.test(value)) {
        throw new Error("Invalid Team Server access token");
      }
      await run([
        "add-generic-password", "-U",
        "-s", service,
        "-a", account(profileId),
        "-w", value,
      ]);
    },
    async get(profileId) {
      try {
        const result = await run([
          "find-generic-password",
          "-s", service,
          "-a", account(profileId),
          "-w",
        ]);
        return result.stdout.trim() || null;
      } catch (error) {
        if (error.code === 44) return null;
        throw error;
      }
    },
    async delete(profileId) {
      try {
        await run([
          "delete-generic-password",
          "-s", service,
          "-a", account(profileId),
        ]);
      } catch (error) {
        if (error.code !== 44) throw error;
      }
    },
  };
}
