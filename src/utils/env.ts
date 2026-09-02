/**
 * Brightspace MCP Server
 * Copyright (c) 2026 Rohan Muppa. All rights reserved.
 * Licensed under MIT — see LICENSE file for details.
 */

import dotenv from "dotenv";
import { existsSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

// build/utils/env.js → project root
const PROJECT_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..", "..");

const ENV_FILES = [".env.local", ".env"] as const;

/**
 * Load `.env.local` then `.env` from the project root into process.env.
 * dotenv never overwrites a variable that is already set, so precedence is:
 * real environment > .env.local > .env. Returns the file names that existed.
 */
export function loadEnvFiles(root: string = PROJECT_ROOT): string[] {
  const loaded: string[] = [];
  for (const name of ENV_FILES) {
    const file = resolve(root, name);
    if (!existsSync(file)) continue;
    dotenv.config({ path: file, quiet: true });
    loaded.push(name);
  }
  return loaded;
}
