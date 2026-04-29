/**
 * @vibecontrols/vibe-plugin-storage-postgres
 *
 * PostgreSQL storage provider for the VibeControls agent.
 * Drop-in alternative to Skalex with full encryption-at-rest parity
 * (AES-256-GCM, per-row IV + auth tag).
 *
 * Importing this module registers the adapter under the name "postgres"
 * with @vibecontrols/vibe-plugin-storage. To use it as the storage
 * backend:
 *
 *   1. Install on the agent host:
 *      vibe plugin install @vibecontrols/vibe-plugin-storage-postgres
 *   2. Tell the agent to use it:
 *      vibe config --set storage-adapter=postgres
 *      (or set VIBE_STORAGE_ADAPTER=postgres in env)
 *   3. Provide a connection string:
 *      vibe config --set postgres-url=postgres://user:pass@host:5432/db
 *      (or set VIBE_POSTGRES_URL in env)
 *
 * The schema is created on first connection (`CREATE TABLE IF NOT EXISTS
 * documents`). No manual migrations needed.
 */

import "./postgres.adapter.js";

export { createPostgresAgentDatabase } from "./postgres.adapter.js";

interface MinimalVibePlugin {
  name: string;
  version: string;
  description?: string;
  tags?: (
    | "backend"
    | "frontend"
    | "cli"
    | "provider"
    | "adapter"
    | "integration"
  )[];
}

export const vibePlugin: MinimalVibePlugin = {
  name: "storage-postgres",
  version: "2026.429.1",
  description:
    "PostgreSQL encrypted storage adapter for the VibeControls agent (registers via side-effect import).",
  tags: ["backend", "adapter", "provider"],
};
