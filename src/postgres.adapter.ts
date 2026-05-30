/**
 * PostgreSQL Storage Adapter
 *
 * Full-parity implementation of the AgentDatabase contract on top of
 * PostgreSQL. The adapter is a drop-in alternative to Skalex when the
 * operator wants centralized storage (multiple agents pointing at the
 * same DB cluster, off-host backups, point-in-time recovery, etc.).
 *
 * Encryption at rest is mandatory and matches Skalex's behavior:
 *   - Every value is AES-256-GCM encrypted in the agent before being
 *     written to the DB.
 *   - The 32-byte key is the same one Skalex receives — fetched per-
 *     workspace from wspace-vibecontrols-svc, never persisted to disk.
 *   - Each row carries its own random 12-byte IV and the GCM auth tag.
 *
 * Schema: one table — `documents(collection text, id text, ciphertext
 * bytea, iv bytea, tag bytea, created_at timestamptz, updated_at
 * timestamptz, PRIMARY KEY(collection, id))`. Filtering by domain
 * fields (e.g. notifications by status) happens after we decrypt and
 * deserialize the document — so this scales to thousands of rows per
 * collection (the typical agent profile), not millions. For larger
 * fleets, sharding by agent ID + heavy filters belongs in a future
 * adapter that pre-extracts indexed columns.
 *
 * Side-effect: importing this module registers the "postgres" adapter
 * with the storage meta plugin's registry. The agent then loads it via
 * `VIBE_STORAGE_ADAPTER=postgres` (or the equivalent option to
 * `createAgentDatabase`).
 */

import { createCipheriv, createDecipheriv, randomBytes } from "node:crypto";
import { dirname, sep } from "node:path";

import {
  AgentDatabase,
  registerAdapter,
  type AgentStorageAdapterFactory,
  type AgentStorageAdapterOptions,
  type Task,
  type GitRepository,
  type BookmarkedCommand,
  type Notification,
  type StorageEntry,
} from "@vibecontrols/vibe-plugin-storage";

// node-postgres is dynamically imported so the module loads cleanly even
// when `pg` isn't yet installed (the agent will surface a clearer error
// at adapter-resolve time).
type PgClient = {
  query: (text: string, values?: unknown[]) => Promise<{ rows: unknown[] }>;
  end: () => Promise<void>;
};
type PgPool = {
  connect: () => Promise<PgClient & { release: () => void }>;
  query: (text: string, values?: unknown[]) => Promise<{ rows: unknown[] }>;
  end: () => Promise<void>;
};

const COLLECTIONS = {
  tasks: "tasks",
  config: "config",
  gitRepos: "git_repositories",
  bookmarks: "bookmarked_commands",
  notifications: "notifications",
  pluginState: "plugin_state",
} as const;

interface RowSnapshot<T> {
  collection: string;
  id: string;
  value: T;
  createdAt: string;
  updatedAt: string;
}

const nowIso = (): string => new Date().toISOString();

function pluginStateId(pluginName: string, key: string): string {
  return `${pluginName}::${key}`;
}

// ── Crypto helpers ────────────────────────────────────────────────────────

interface EncryptedBlob {
  ciphertext: Buffer;
  iv: Buffer;
  tag: Buffer;
}

function deriveKey(hex: string): Buffer {
  if (!/^[0-9a-fA-F]{64}$/.test(hex)) {
    throw new Error(
      "vibe-plugin-storage-postgres: encryption key must be a 64-character hex string (32 bytes)",
    );
  }
  return Buffer.from(hex, "hex");
}

function encrypt(plaintext: string, key: Buffer): EncryptedBlob {
  const iv = randomBytes(12);
  const cipher = createCipheriv("aes-256-gcm", key, iv);
  const ct = Buffer.concat([cipher.update(plaintext, "utf8"), cipher.final()]);
  return { ciphertext: ct, iv, tag: cipher.getAuthTag() };
}

function decrypt(blob: EncryptedBlob, key: Buffer): string {
  const decipher = createDecipheriv("aes-256-gcm", key, blob.iv);
  decipher.setAuthTag(blob.tag);
  const pt = Buffer.concat([
    decipher.update(blob.ciphertext),
    decipher.final(),
  ]);
  return pt.toString("utf8");
}

// ── Adapter implementation ────────────────────────────────────────────────

class PostgresAgentDatabase extends AgentDatabase {
  private pool: PgPool;
  private key: Buffer;
  private connStr: string;

  constructor(pool: PgPool, key: Buffer, connStr: string) {
    super();
    this.pool = pool;
    this.key = key;
    this.connStr = connStr;
  }

  async init(): Promise<void> {
    await this.pool.query(`
      CREATE TABLE IF NOT EXISTS documents (
        collection text NOT NULL,
        id text NOT NULL,
        ciphertext bytea NOT NULL,
        iv bytea NOT NULL,
        tag bytea NOT NULL,
        created_at timestamptz NOT NULL DEFAULT now(),
        updated_at timestamptz NOT NULL DEFAULT now(),
        PRIMARY KEY (collection, id)
      );
      CREATE INDEX IF NOT EXISTS idx_doc_collection ON documents (collection);
      CREATE INDEX IF NOT EXISTS idx_doc_updated_at ON documents (updated_at);
    `);
  }

  // ── Internal CRUD helpers (work in plaintext, encrypt on write) ─────────

  private async putDoc<T>(
    collection: string,
    id: string,
    value: T,
    options?: { keepCreatedAt?: boolean },
  ): Promise<void> {
    const json = JSON.stringify(value);
    const blob = encrypt(json, this.key);
    if (options?.keepCreatedAt) {
      await this.pool.query(
        `INSERT INTO documents (collection, id, ciphertext, iv, tag) VALUES ($1, $2, $3, $4, $5)
         ON CONFLICT (collection, id) DO UPDATE SET ciphertext = EXCLUDED.ciphertext, iv = EXCLUDED.iv, tag = EXCLUDED.tag, updated_at = now()`,
        [collection, id, blob.ciphertext, blob.iv, blob.tag],
      );
    } else {
      await this.pool.query(
        `INSERT INTO documents (collection, id, ciphertext, iv, tag) VALUES ($1, $2, $3, $4, $5)
         ON CONFLICT (collection, id) DO UPDATE SET ciphertext = EXCLUDED.ciphertext, iv = EXCLUDED.iv, tag = EXCLUDED.tag, updated_at = now()`,
        [collection, id, blob.ciphertext, blob.iv, blob.tag],
      );
    }
  }

  private async getDoc<T>(
    collection: string,
    id: string,
  ): Promise<RowSnapshot<T> | null> {
    const r = await this.pool.query(
      `SELECT id, ciphertext, iv, tag, created_at, updated_at FROM documents WHERE collection = $1 AND id = $2`,
      [collection, id],
    );
    const row = r.rows[0] as
      | {
          id: string;
          ciphertext: Buffer;
          iv: Buffer;
          tag: Buffer;
          created_at: Date;
          updated_at: Date;
        }
      | undefined;
    if (!row) return null;
    const json = decrypt(
      { ciphertext: row.ciphertext, iv: row.iv, tag: row.tag },
      this.key,
    );
    return {
      collection,
      id: row.id,
      value: JSON.parse(json) as T,
      createdAt: row.created_at.toISOString(),
      updatedAt: row.updated_at.toISOString(),
    };
  }

  private async listDocs<T>(collection: string): Promise<RowSnapshot<T>[]> {
    const r = await this.pool.query(
      `SELECT id, ciphertext, iv, tag, created_at, updated_at FROM documents WHERE collection = $1 ORDER BY created_at DESC`,
      [collection],
    );
    return r.rows.map((row) => {
      const r = row as {
        id: string;
        ciphertext: Buffer;
        iv: Buffer;
        tag: Buffer;
        created_at: Date;
        updated_at: Date;
      };
      const json = decrypt(
        { ciphertext: r.ciphertext, iv: r.iv, tag: r.tag },
        this.key,
      );
      return {
        collection,
        id: r.id,
        value: JSON.parse(json) as T,
        createdAt: r.created_at.toISOString(),
        updatedAt: r.updated_at.toISOString(),
      };
    });
  }

  private async deleteDoc(collection: string, id: string): Promise<boolean> {
    const r = (await this.pool.query(
      `DELETE FROM documents WHERE collection = $1 AND id = $2`,
      [collection, id],
    )) as unknown as { rowCount: number };
    return (r.rowCount ?? 0) > 0;
  }

  // ── Lifecycle ───────────────────────────────────────────────────────────

  async close(): Promise<void> {
    await this.pool.end();
  }

  getDbPath(): string {
    return this.connStr;
  }

  /**
   * Snapshot via `pg_dump --format=custom`. Requires `pg_dump` on PATH
   * (Bun container images ship it). Restore = `pg_restore --clean`.
   */
  async backup(targetPath: string): Promise<void> {
    const pgDump = Bun.which("pg_dump", { PATH: process.env.PATH });
    if (pgDump === null) {
      throw new Error(
        "Postgres backup failed: PostgreSQL client tools not found on PATH " +
          "(could not locate `pg_dump`). Install the PostgreSQL client tools " +
          "and ensure `pg_dump` is on PATH.",
      );
    }
    const proc = Bun.spawn(
      [pgDump, "--format=custom", "--file", targetPath, this.connStr],
      { stdout: "pipe", stderr: "pipe" },
    );
    const exitCode = await proc.exited;
    if (exitCode !== 0) {
      const err = await new Response(proc.stderr).text();
      throw new Error(`Postgres backup failed (exit ${exitCode}): ${err}`);
    }
  }

  // ── Tasks ───────────────────────────────────────────────────────────────

  async createTask(task: Omit<Task, "createdAt" | "updatedAt">): Promise<Task> {
    const now = nowIso();
    const value: Task = { ...task, createdAt: now, updatedAt: now };
    await this.putDoc(COLLECTIONS.tasks, task.id, value);
    return value;
  }

  async getTask(id: string): Promise<Task | undefined> {
    const r = await this.getDoc<Task>(COLLECTIONS.tasks, id);
    return r?.value;
  }

  async getAllTasks(): Promise<Task[]> {
    const docs = await this.listDocs<Task>(COLLECTIONS.tasks);
    return docs.map((d) => d.value);
  }

  async getPendingTasks(): Promise<Task[]> {
    const all = await this.getAllTasks();
    return all.filter((t) => t.status === "pending");
  }

  async updateTask(id: string, updates: Partial<Task>): Promise<void> {
    const existing = await this.getDoc<Task>(COLLECTIONS.tasks, id);
    if (!existing) return;
    const next: Task = {
      ...existing.value,
      ...updates,
      updatedAt: nowIso(),
    };
    await this.putDoc(COLLECTIONS.tasks, id, next, { keepCreatedAt: true });
  }

  async cancelTask(id: string): Promise<boolean> {
    const existing = await this.getDoc<Task>(COLLECTIONS.tasks, id);
    if (!existing) return false;
    if (
      existing.value.status === "completed" ||
      existing.value.status === "failed"
    ) {
      return false;
    }
    const next: Task = {
      ...existing.value,
      status: "failed",
      error: "Cancelled by user",
      updatedAt: nowIso(),
    };
    await this.putDoc(COLLECTIONS.tasks, id, next, { keepCreatedAt: true });
    return true;
  }

  // ── Config ──────────────────────────────────────────────────────────────

  async getConfig(key: string): Promise<string | undefined> {
    const r = await this.getDoc<{ key: string; value: string }>(
      COLLECTIONS.config,
      key,
    );
    return r?.value.value;
  }

  async setConfig(key: string, value: string): Promise<void> {
    await this.putDoc(COLLECTIONS.config, key, { key, value });
  }

  async deleteConfig(key: string): Promise<boolean> {
    return this.deleteDoc(COLLECTIONS.config, key);
  }

  async getAllConfig(): Promise<Record<string, string>> {
    const docs = await this.listDocs<{ key: string; value: string }>(
      COLLECTIONS.config,
    );
    const out: Record<string, string> = {};
    for (const d of docs) out[d.value.key] = d.value.value;
    return out;
  }

  async bulkSetConfig(entries: Record<string, string>): Promise<void> {
    for (const [k, v] of Object.entries(entries)) {
      await this.setConfig(k, v);
    }
  }

  async getConfigStatus(): Promise<{
    totalKeys: number;
    lastUpdated: string | null;
  }> {
    const r = await this.pool.query(
      `SELECT COUNT(*)::int AS n, MAX(updated_at) AS last_updated FROM documents WHERE collection = $1`,
      [COLLECTIONS.config],
    );
    const row = r.rows[0] as { n: number; last_updated: Date | null };
    return {
      totalKeys: row.n,
      lastUpdated: row.last_updated ? row.last_updated.toISOString() : null,
    };
  }

  // ── Git Repositories ────────────────────────────────────────────────────

  async createGitRepository(
    repo: Omit<GitRepository, "createdAt" | "lastScanned">,
  ): Promise<GitRepository> {
    const now = nowIso();
    const value: GitRepository = { ...repo, createdAt: now, lastScanned: now };
    await this.putDoc(COLLECTIONS.gitRepos, repo.id, value);
    return value;
  }

  async getGitRepository(id: string): Promise<GitRepository | undefined> {
    const r = await this.getDoc<GitRepository>(COLLECTIONS.gitRepos, id);
    return r?.value;
  }

  async getGitRepositoryByPath(
    path: string,
  ): Promise<GitRepository | undefined> {
    const all = await this.listDocs<GitRepository>(COLLECTIONS.gitRepos);
    return all.find((d) => d.value.path === path)?.value;
  }

  async getAllGitRepositories(): Promise<GitRepository[]> {
    const docs = await this.listDocs<GitRepository>(COLLECTIONS.gitRepos);
    return docs.map((d) => d.value);
  }

  async updateGitRepository(
    id: string,
    updates: Partial<GitRepository>,
  ): Promise<void> {
    const existing = await this.getDoc<GitRepository>(COLLECTIONS.gitRepos, id);
    if (!existing) return;
    const next: GitRepository = {
      ...existing.value,
      ...updates,
      lastScanned: nowIso(),
    };
    await this.putDoc(COLLECTIONS.gitRepos, id, next, { keepCreatedAt: true });
  }

  async deleteGitRepository(id: string): Promise<boolean> {
    return this.deleteDoc(COLLECTIONS.gitRepos, id);
  }

  async fixGitHierarchy(): Promise<{ fixed: number }> {
    const all = await this.getAllGitRepositories();
    const byPath = new Map(all.map((r) => [r.path, r] as const));
    let fixed = 0;
    for (const repo of all) {
      // `repo.path` is a real filesystem path (populated from on-disk git
      // scans). Walk its ancestor directories nearest-first and pick the
      // closest one that is itself a tracked repo. Using `node:path` keeps
      // this correct on Windows (backslash separators) while remaining
      // byte-for-byte identical to the previous "/"-split logic on POSIX.
      let parent: string | undefined;
      let current = repo.path;
      for (;;) {
        const candidate = dirname(current);
        if (candidate === current || candidate === sep || candidate === ".") {
          break;
        }
        if (byPath.has(candidate) && candidate !== repo.path) {
          parent = candidate;
          break;
        }
        current = candidate;
      }
      if (parent !== repo.parentPath) {
        await this.updateGitRepository(repo.id, { parentPath: parent });
        fixed += 1;
      }
    }
    return { fixed };
  }

  // ── Bookmarked Commands ─────────────────────────────────────────────────

  async createBookmarkedCommand(
    cmd: Omit<BookmarkedCommand, "createdAt">,
  ): Promise<BookmarkedCommand> {
    const value: BookmarkedCommand = { ...cmd, createdAt: nowIso() };
    await this.putDoc(COLLECTIONS.bookmarks, cmd.id, value);
    return value;
  }

  async getBookmarkedCommand(
    id: string,
  ): Promise<BookmarkedCommand | undefined> {
    const r = await this.getDoc<BookmarkedCommand>(COLLECTIONS.bookmarks, id);
    return r?.value;
  }

  async getAllBookmarkedCommands(): Promise<BookmarkedCommand[]> {
    const docs = await this.listDocs<BookmarkedCommand>(COLLECTIONS.bookmarks);
    return docs.map((d) => d.value);
  }

  async getBookmarkedCommandsByProject(
    projectId: string | null,
  ): Promise<BookmarkedCommand[]> {
    const all = await this.getAllBookmarkedCommands();
    return all.filter((c) =>
      projectId === null
        ? c.projectId === undefined || c.projectId === null
        : c.projectId === projectId,
    );
  }

  async getBookmarkedCommandsByCategory(
    category: string,
  ): Promise<BookmarkedCommand[]> {
    const all = await this.getAllBookmarkedCommands();
    return all.filter((c) => c.category === category);
  }

  async updateBookmarkedCommand(
    id: string,
    updates: Partial<BookmarkedCommand>,
  ): Promise<void> {
    const existing = await this.getDoc<BookmarkedCommand>(
      COLLECTIONS.bookmarks,
      id,
    );
    if (!existing) return;
    const next: BookmarkedCommand = { ...existing.value, ...updates };
    await this.putDoc(COLLECTIONS.bookmarks, id, next, { keepCreatedAt: true });
  }

  async deleteBookmarkedCommand(id: string): Promise<boolean> {
    return this.deleteDoc(COLLECTIONS.bookmarks, id);
  }

  async executeBookmarkedCommand(
    id: string,
  ): Promise<BookmarkedCommand | undefined> {
    return this.getBookmarkedCommand(id);
  }

  // ── Notifications ───────────────────────────────────────────────────────

  async createNotification(
    notification: Omit<Notification, "createdAt">,
  ): Promise<Notification> {
    const value: Notification = { ...notification, createdAt: nowIso() };
    await this.putDoc(COLLECTIONS.notifications, notification.id, value);
    return value;
  }

  async getNotification(id: string): Promise<Notification | undefined> {
    const r = await this.getDoc<Notification>(COLLECTIONS.notifications, id);
    return r?.value;
  }

  async getAllNotifications(): Promise<Notification[]> {
    const docs = await this.listDocs<Notification>(COLLECTIONS.notifications);
    return docs.map((d) => d.value);
  }

  async getNotificationsByProject(
    projectId: string | null,
  ): Promise<Notification[]> {
    const all = await this.getAllNotifications();
    return all.filter((n) =>
      projectId === null
        ? n.projectId === undefined || n.projectId === null
        : n.projectId === projectId,
    );
  }

  async getGlobalNotifications(): Promise<Notification[]> {
    const all = await this.getAllNotifications();
    return all.filter((n) => !n.projectId);
  }

  async getUnreadNotifications(): Promise<Notification[]> {
    const all = await this.getAllNotifications();
    return all.filter((n) => n.status === "unread");
  }

  async updateNotificationStatus(
    id: string,
    status: "unread" | "read",
  ): Promise<void> {
    const existing = await this.getDoc<Notification>(
      COLLECTIONS.notifications,
      id,
    );
    if (!existing) return;
    const next: Notification = { ...existing.value, status };
    await this.putDoc(COLLECTIONS.notifications, id, next, {
      keepCreatedAt: true,
    });
  }

  async markAllNotificationsRead(): Promise<number> {
    const all = await this.getAllNotifications();
    let count = 0;
    for (const n of all) {
      if (n.status === "unread") {
        await this.updateNotificationStatus(n.id, "read");
        count += 1;
      }
    }
    return count;
  }

  async deleteNotification(id: string): Promise<boolean> {
    return this.deleteDoc(COLLECTIONS.notifications, id);
  }

  async clearOldNotifications(olderThanDays: number = 30): Promise<number> {
    const cutoff = Date.now() - olderThanDays * 86_400_000;
    const all = await this.getAllNotifications();
    let count = 0;
    for (const n of all) {
      if (Date.parse(n.createdAt) < cutoff) {
        await this.deleteDoc(COLLECTIONS.notifications, n.id);
        count += 1;
      }
    }
    return count;
  }

  // ── Plugin State ────────────────────────────────────────────────────────

  async getPluginState(
    pluginName: string,
    key: string,
  ): Promise<string | undefined> {
    const r = await this.getDoc<{ value: string }>(
      COLLECTIONS.pluginState,
      pluginStateId(pluginName, key),
    );
    return r?.value.value;
  }

  async setPluginState(
    pluginName: string,
    key: string,
    value: string,
  ): Promise<void> {
    await this.putDoc(COLLECTIONS.pluginState, pluginStateId(pluginName, key), {
      pluginName,
      key,
      value,
    });
  }

  async deletePluginState(pluginName: string, key: string): Promise<boolean> {
    return this.deleteDoc(
      COLLECTIONS.pluginState,
      pluginStateId(pluginName, key),
    );
  }

  async getAllPluginState(pluginName: string): Promise<StorageEntry[]> {
    const docs = await this.listDocs<{
      pluginName: string;
      key: string;
      value: string;
    }>(COLLECTIONS.pluginState);
    return docs
      .filter((d) => d.value.pluginName === pluginName)
      .map((d) => ({
        key: d.value.key,
        value: d.value.value,
        updatedAt: d.updatedAt,
      }));
  }

  async deleteAllPluginState(pluginName: string): Promise<number> {
    const r = (await this.pool.query(
      `DELETE FROM documents WHERE collection = $1 AND id LIKE $2`,
      [COLLECTIONS.pluginState, `${pluginName}::%`],
    )) as unknown as { rowCount: number };
    return r.rowCount ?? 0;
  }
}

// ── Factory + registration ────────────────────────────────────────────────

export const createPostgresAgentDatabase: AgentStorageAdapterFactory = async (
  opts: AgentStorageAdapterOptions,
): Promise<AgentDatabase> => {
  // Connection string sources, in priority:
  //   1. opts.adapterOptions.connectionString — host-controlled, the
  //      preferred path (the agent forwards its config blob verbatim)
  //   2. opts.dataDir if it's a postgres:// URL (host re-purpose hack)
  //   3. VIBE_POSTGRES_URL env var (operator escape hatch)
  //   4. fail closed
  let connStr: string | undefined;
  const fromOptions = opts.adapterOptions?.connectionString;
  if (fromOptions) {
    connStr = fromOptions;
  } else if (opts.dataDir && /^(postgres|postgresql):\/\//.test(opts.dataDir)) {
    connStr = opts.dataDir;
  } else if (process.env.VIBE_POSTGRES_URL) {
    connStr = process.env.VIBE_POSTGRES_URL;
  }
  if (!connStr) {
    throw new Error(
      "vibe-plugin-storage-postgres: connection string required. " +
        "Pass via adapterOptions.connectionString (preferred), set " +
        "VIBE_POSTGRES_URL, or pass a postgres:// URL as dbPath.",
    );
  }

  const key = deriveKey(opts.encryptionKey);
  // Dynamically import pg so this module loads even without pg installed.
  // Cast to a permissive shape — the runtime API is what we exercise here.
  const pgModule = (await import("pg")) as unknown as {
    Pool?: new (cfg: { connectionString: string }) => PgPool;
    default?: { Pool: new (cfg: { connectionString: string }) => PgPool };
  };
  const PoolCtor = pgModule.Pool ?? pgModule.default?.Pool;
  if (!PoolCtor) {
    throw new Error("vibe-plugin-storage-postgres: failed to load 'pg' module");
  }
  const pool = new PoolCtor({ connectionString: connStr });
  const adapter = new PostgresAgentDatabase(pool, key, connStr);
  await adapter.init();
  return adapter;
};

registerAdapter("postgres", createPostgresAgentDatabase);
