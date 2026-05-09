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

import {
  type HostServices,
  type ProfileContext,
  type VibePlugin,
  type VibePluginFactory,
} from "@vibecontrols/plugin-sdk/contract";
import { createLifecycleHooks } from "@vibecontrols/plugin-sdk/lifecycle";
import { BoundLogger } from "@vibecontrols/plugin-sdk/log";
import { ProviderRegistry } from "@vibecontrols/plugin-sdk/providers";
import { TelemetryEmitter } from "@vibecontrols/plugin-sdk/telemetry";

// Side-effect: register the "postgres" adapter on import (with the
// `vibe-plugin-storage` peer-dep adapter registry).
import "./postgres.adapter.js";

import { createPostgresAgentDatabase } from "./postgres.adapter.js";

export { createPostgresAgentDatabase } from "./postgres.adapter.js";

const PLUGIN_NAME = "storage-postgres";
const PLUGIN_VERSION = "2026.509.4";

export const createPlugin: VibePluginFactory = (
  ctx: ProfileContext,
): VibePlugin => {
  const log = new BoundLogger(ctx.logger, PLUGIN_NAME);
  const lifecycle = createLifecycleHooks({
    name: PLUGIN_NAME,
    telemetryEventName: "storage-postgres.ready",
    onInit: (hostServices: HostServices) => {
      const providers = new ProviderRegistry(hostServices);
      providers.registerProvider(
        "storage",
        "postgres",
        createPostgresAgentDatabase,
      );
      const telemetry = new TelemetryEmitter(
        PLUGIN_NAME,
        PLUGIN_VERSION,
        hostServices,
      );
      telemetry.emit("storage-postgres.registered", { adapter: "postgres" });
      log.info(
        "postgres storage adapter registered with host ProviderRegistry",
      );
    },
  });

  return {
    name: PLUGIN_NAME,
    version: PLUGIN_VERSION,
    description:
      "PostgreSQL encrypted storage adapter (registers via side-effect import).",
    tags: ["backend", "adapter", "provider"],
    capabilities: {
      storage: "rw",
      secrets: "read",
    },
    onServerStart: lifecycle.onServerStart,
    onServerStop: lifecycle.onServerStop,
  };
};

export default createPlugin;
