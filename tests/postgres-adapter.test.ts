/**
 * E2E parity tests for the postgres adapter.
 *
 * Hits a real Postgres (wspace-shared-postgres on localhost:5432, db
 * `vibecontrols_agent_pg_test`). Skips silently when VIBE_POSTGRES_TEST_URL
 * isn't set so CI doesn't hard-fail without the docker container.
 *
 * Goal: every method on the AgentDatabase contract returns the same shape
 * and behavior as the Skalex reference implementation. Where possible the
 * tests mirror the Skalex test suite verbatim.
 */

import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { createPostgresAgentDatabase } from "../src/postgres.adapter.js";
import type { AgentDatabase, Task } from "@vibecontrols/vibe-plugin-storage";

const TEST_URL = process.env.VIBE_POSTGRES_TEST_URL;
const KEY = "0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef";

const maybeDescribe = TEST_URL ? describe : describe.skip;

maybeDescribe("PostgresAgentDatabase parity", () => {
  let db: AgentDatabase;

  beforeAll(async () => {
    db = await createPostgresAgentDatabase({
      dataDir: TEST_URL!,
      encryptionKey: KEY,
    });
    // Wipe any prior test data
    const cfg = await db.getAllConfig();
    for (const k of Object.keys(cfg)) await db.deleteConfig(k);
    for (const t of await db.getAllTasks()) await db.cancelTask(t.id);
    for (const n of await db.getAllNotifications())
      await db.deleteNotification(n.id);
    for (const r of await db.getAllGitRepositories())
      await db.deleteGitRepository(r.id);
    for (const b of await db.getAllBookmarkedCommands())
      await db.deleteBookmarkedCommand(b.id);
  });

  afterAll(async () => {
    await db.close();
  });

  test("config: set/get/delete/getAll/bulk/status round-trip", async () => {
    await db.setConfig("k1", "v1");
    expect(await db.getConfig("k1")).toBe("v1");
    await db.bulkSetConfig({ k2: "v2", k3: "v3" });
    const all = await db.getAllConfig();
    expect(all).toEqual({ k1: "v1", k2: "v2", k3: "v3" });
    expect(await db.deleteConfig("k1")).toBe(true);
    expect(await db.getConfig("k1")).toBeUndefined();
    const status = await db.getConfigStatus();
    expect(status.totalKeys).toBe(2);
    expect(typeof status.lastUpdated).toBe("string");
  });

  test("tasks: create, list, update, cancel, getPending", async () => {
    const t1 = await db.createTask({
      id: "t-1",
      type: "command",
      status: "pending",
      payload: "echo hi",
    });
    expect(t1.createdAt).toBeTruthy();
    expect(t1.updatedAt).toBeTruthy();
    expect(await db.getTask("t-1")).toEqual(t1);

    const t2 = await db.createTask({
      id: "t-2",
      type: "script",
      status: "running",
      payload: "ls",
    });
    const all = await db.getAllTasks();
    expect(all.length).toBeGreaterThanOrEqual(2);
    expect((await db.getPendingTasks()).map((t: Task) => t.id)).toContain(
      "t-1",
    );

    await db.updateTask("t-1", { status: "running" });
    expect((await db.getTask("t-1"))?.status).toBe("running");

    expect(await db.cancelTask("t-1")).toBe(true);
    expect((await db.getTask("t-1"))?.status).toBe("failed");

    expect(await db.cancelTask("nope")).toBe(false);
  });

  test("git repos: create, lookup-by-path, hierarchy fix", async () => {
    await db.createGitRepository({
      id: "g1",
      path: "/work/project",
      name: "project",
      isSubmodule: false,
    });
    await db.createGitRepository({
      id: "g2",
      path: "/work/project/sub",
      name: "sub",
      isSubmodule: true,
    });
    const r = await db.getGitRepositoryByPath("/work/project/sub");
    expect(r?.id).toBe("g2");
    const fix = await db.fixGitHierarchy();
    expect(fix.fixed).toBeGreaterThanOrEqual(1);
    const sub = await db.getGitRepository("g2");
    expect(sub?.parentPath).toBe("/work/project");
  });

  test("bookmarked commands: create, by-project, by-category, update, delete", async () => {
    await db.createBookmarkedCommand({
      id: "b1",
      command: "ls",
      projectId: "p1",
      category: "fs",
    });
    await db.createBookmarkedCommand({
      id: "b2",
      command: "pwd",
      projectId: "p1",
      category: "fs",
    });
    await db.createBookmarkedCommand({
      id: "b3",
      command: "git status",
      category: "git",
    });
    expect((await db.getBookmarkedCommandsByProject("p1")).length).toBe(2);
    expect((await db.getBookmarkedCommandsByCategory("fs")).length).toBe(2);
    expect((await db.getBookmarkedCommandsByProject(null)).length).toBe(1);
    await db.updateBookmarkedCommand("b1", { description: "list files" });
    expect((await db.getBookmarkedCommand("b1"))?.description).toBe(
      "list files",
    );
    expect(await db.deleteBookmarkedCommand("b1")).toBe(true);
    expect(await db.deleteBookmarkedCommand("b1")).toBe(false);
  });

  test("notifications: lifecycle (create, project filter, mark-read, clear-old, delete)", async () => {
    await db.createNotification({
      id: "n1",
      type: "info",
      title: "hi",
      message: "m",
      status: "unread",
      projectId: "p1",
    });
    await db.createNotification({
      id: "n2",
      type: "warning",
      title: "warn",
      message: "m2",
      status: "unread",
    });
    expect((await db.getUnreadNotifications()).length).toBe(2);
    expect((await db.getNotificationsByProject("p1")).length).toBe(1);
    expect((await db.getGlobalNotifications()).length).toBe(1);
    await db.updateNotificationStatus("n1", "read");
    expect((await db.getNotification("n1"))?.status).toBe("read");
    expect(await db.markAllNotificationsRead()).toBe(1);
    expect((await db.getUnreadNotifications()).length).toBe(0);
    expect(await db.deleteNotification("n1")).toBe(true);
    // clearOldNotifications with 0 days: everything qualifies
    const cleared = await db.clearOldNotifications(0);
    expect(cleared).toBeGreaterThanOrEqual(1);
  });

  test("plugin state: namespaced get/set/delete, list, deleteAll", async () => {
    await db.setPluginState("foo", "k1", "v1");
    await db.setPluginState("foo", "k2", "v2");
    await db.setPluginState("bar", "k1", "other");
    expect(await db.getPluginState("foo", "k1")).toBe("v1");
    const fooEntries = await db.getAllPluginState("foo");
    expect(fooEntries.length).toBe(2);
    expect(await db.deletePluginState("foo", "k1")).toBe(true);
    expect(await db.getPluginState("foo", "k1")).toBeUndefined();
    const removed = await db.deleteAllPluginState("foo");
    expect(removed).toBeGreaterThanOrEqual(1);
    // bar untouched
    expect(await db.getPluginState("bar", "k1")).toBe("other");
  });

  test("encryption at rest: ciphertext column does NOT contain plaintext", async () => {
    await db.setConfig("secret-marker", "PLAINTEXT_SHOULD_NOT_APPEAR_42");
    // Read raw bytes from the DB and confirm the plaintext doesn't appear.
    const pgModule = await import("pg");
    const Pool = (pgModule as any).Pool ?? (pgModule as any).default.Pool;
    const pool = new Pool({ connectionString: TEST_URL! });
    const r = await pool.query(
      `SELECT ciphertext FROM documents WHERE collection = 'config' AND id = 'secret-marker'`,
    );
    await pool.end();
    expect(r.rows.length).toBe(1);
    const buf = (r.rows[0] as { ciphertext: Buffer }).ciphertext;
    const text = buf.toString("utf8");
    expect(text).not.toContain("PLAINTEXT_SHOULD_NOT_APPEAR_42");
  });

  test("getDbPath returns connection string", () => {
    expect(db.getDbPath()).toBe(TEST_URL!);
  });
});
