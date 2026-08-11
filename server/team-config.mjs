import { randomUUID } from "node:crypto";
import { chmod, mkdir, readFile, rename, writeFile } from "node:fs/promises";
import path from "node:path";

const DEFAULT_SYNC = Object.freeze({
  cursor: "0",
  status: "idle",
  pendingOperations: 0,
  lastSuccessfulSyncAt: null,
  paused: false,
});

function normalizeUrl(value) {
  let url;
  try {
    url = new URL(value);
  } catch {
    throw new Error("Team Server URL must be a valid HTTPS URL");
  }
  if (url.protocol !== "https:" || url.username || url.password || url.search || url.hash) {
    throw new Error("Team Server URL must use HTTPS without credentials, query, or fragment");
  }
  url.pathname = url.pathname.replace(/\/+$/, "");
  return url.toString().replace(/\/$/, "");
}

function cleanText(value, field, { required = false, maxLength = 256 } = {}) {
  const result = typeof value === "string" ? value.trim() : "";
  if (required && !result) throw new Error(`${field} is required`);
  if (result.length > maxLength || /[\u0000-\u001f\u007f]/.test(result)) {
    throw new Error(`${field} is invalid`);
  }
  return result;
}

function normalizeProfile(input, id) {
  return {
    id,
    name: cleanText(input.name, "Team Server name", { required: true, maxLength: 120 }),
    url: normalizeUrl(input.url),
    organizationId: cleanText(input.organizationId, "organizationId", { maxLength: 256 }) || null,
    serverMetadata: input.serverMetadata && typeof input.serverMetadata === "object"
      ? structuredClone(input.serverMetadata)
      : {},
    updateMirror: Boolean(input.updateMirror),
    workspaceMappings: {},
    sync: { ...DEFAULT_SYNC },
    createdAt: new Date().toISOString(),
    updatedAt: new Date().toISOString(),
  };
}

function publicConfig(config) {
  return {
    schemaVersion: 1,
    activeProfileId: config.activeProfileId,
    profiles: config.profiles.map((profile) => ({
      ...structuredClone(profile),
      active: profile.id === config.activeProfileId,
    })),
  };
}

export function createTeamConfigStore({ configPath, randomId = randomUUID }) {
  if (!path.isAbsolute(configPath)) throw new Error("Team config path must be absolute");
  let writeQueue = Promise.resolve();

  async function readRaw() {
    try {
      const value = JSON.parse(await readFile(configPath, "utf8"));
      if (value?.schemaVersion !== 1 || !Array.isArray(value.profiles)) {
        throw new Error("Team Server config has an unsupported schema");
      }
      return {
        schemaVersion: 1,
        activeProfileId: typeof value.activeProfileId === "string" ? value.activeProfileId : null,
        profiles: value.profiles,
      };
    } catch (error) {
      if (error.code === "ENOENT") return { schemaVersion: 1, activeProfileId: null, profiles: [] };
      throw error;
    }
  }

  async function writeRaw(config) {
    const temporaryPath = `${configPath}.${process.pid}.${Date.now()}.tmp`;
    await mkdir(path.dirname(configPath), { recursive: true, mode: 0o700 });
    await writeFile(temporaryPath, `${JSON.stringify(config, null, 2)}\n`, { mode: 0o600 });
    await chmod(temporaryPath, 0o600);
    await rename(temporaryPath, configPath);
    await chmod(configPath, 0o600);
  }

  function mutate(operation) {
    const result = writeQueue.catch(() => {}).then(async () => {
      const config = await readRaw();
      const value = await operation(config);
      await writeRaw(config);
      return value;
    });
    writeQueue = result.then(() => undefined, () => undefined);
    return result;
  }

  return {
    async read() {
      await writeQueue;
      return publicConfig(await readRaw());
    },
    create(input) {
      return mutate((config) => {
        const id = cleanText(randomId(), "profile id", { required: true, maxLength: 128 });
        if (config.profiles.some((profile) => profile.id === id)) {
          throw new Error(`Team Server profile '${id}' already exists`);
        }
        const profile = normalizeProfile(input, id);
        config.profiles.push(profile);
        if (!config.activeProfileId) config.activeProfileId = id;
        return { ...structuredClone(profile), active: config.activeProfileId === id };
      });
    },
    update(id, changes) {
      return mutate((config) => {
        const profile = config.profiles.find((candidate) => candidate.id === id);
        if (!profile) throw new Error(`Team Server profile '${id}' does not exist`);
        if (changes.name !== undefined) {
          profile.name = cleanText(changes.name, "Team Server name", { required: true, maxLength: 120 });
        }
        if (changes.url !== undefined) profile.url = normalizeUrl(changes.url);
        if (changes.organizationId !== undefined) {
          profile.organizationId = cleanText(changes.organizationId, "organizationId", { maxLength: 256 }) || null;
        }
        if (changes.updateMirror !== undefined) profile.updateMirror = Boolean(changes.updateMirror);
        profile.updatedAt = new Date().toISOString();
        return { ...structuredClone(profile), active: config.activeProfileId === id };
      });
    },
    updateState(id, changes) {
      return mutate((config) => {
        const profile = config.profiles.find((candidate) => candidate.id === id);
        if (!profile) throw new Error(`Team Server profile '${id}' does not exist`);
        if (changes.workspaceMappings !== undefined) {
          profile.workspaceMappings = structuredClone(changes.workspaceMappings);
        }
        profile.sync = { ...DEFAULT_SYNC, ...profile.sync, ...changes };
        delete profile.sync.workspaceMappings;
        profile.updatedAt = new Date().toISOString();
        return { ...structuredClone(profile), active: config.activeProfileId === id };
      });
    },
    activate(id) {
      return mutate((config) => {
        if (!config.profiles.some((profile) => profile.id === id)) {
          throw new Error(`Team Server profile '${id}' does not exist`);
        }
        config.activeProfileId = id;
        return publicConfig(config);
      });
    },
    delete(id) {
      return mutate((config) => {
        const before = config.profiles.length;
        config.profiles = config.profiles.filter((profile) => profile.id !== id);
        if (config.profiles.length === before) {
          throw new Error(`Team Server profile '${id}' does not exist`);
        }
        if (config.activeProfileId === id) config.activeProfileId = config.profiles[0]?.id ?? null;
        return publicConfig(config);
      });
    },
  };
}
