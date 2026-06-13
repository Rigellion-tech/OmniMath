import fs from "node:fs";
import path from "node:path";

let envLoaded = false;
let envLoadStatus = {
  cwd: process.cwd(),
  loadedFiles: [],
  dotenvPackage: "not installed",
};

export function loadEnvFiles(cwd = process.cwd()) {
  if (envLoaded) return envLoadStatus;

  const loadedFiles = [];
  for (const fileName of [".env.local", ".env"]) {
    const filePath = path.join(cwd, fileName);
    if (!fs.existsSync(filePath)) continue;

    const file = fs.readFileSync(filePath, "utf8");
    for (const line of file.split(/\r?\n/)) {
      const trimmed = line.trim();
      if (!trimmed || trimmed.startsWith("#")) continue;

      const separatorIndex = trimmed.indexOf("=");
      if (separatorIndex === -1) continue;

      const key = trimmed.slice(0, separatorIndex).trim();
      let value = trimmed.slice(separatorIndex + 1).trim();
      if (!key || process.env[key] !== undefined) continue;

      if (
        (value.startsWith('"') && value.endsWith('"')) ||
        (value.startsWith("'") && value.endsWith("'"))
      ) {
        value = value.slice(1, -1);
      }

      process.env[key] = value;
    }

    loadedFiles.push(fileName);
  }

  envLoaded = true;
  envLoadStatus = {
    cwd,
    loadedFiles,
    dotenvPackage: "not installed",
  };

  return envLoadStatus;
}

export function getEnvLoadStatus() {
  return envLoadStatus;
}
