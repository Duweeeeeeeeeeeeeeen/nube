import { readFile } from "node:fs/promises";
import { Pool } from "pg";

export const cloudDatabaseProvider = () => (process.env.NUBE_CLOUD_DATABASE_PROVIDER ?? "postgres").toLowerCase();

export const cloudDatabaseConfigured = () => Boolean(process.env.NUBE_CLOUD_DATABASE_URL);

let pool;
let schemaReady = false;

const sslConfig = () => {
  const raw = String(process.env.NUBE_CLOUD_DATABASE_SSL ?? "true").toLowerCase();
  if (["0", "false", "off", "no"].includes(raw)) return false;
  return { rejectUnauthorized: false };
};

export const cloudDatabaseEnabledFor = (user) => cloudDatabaseConfigured() && Boolean(user?.id);

export function getCloudDatabasePool() {
  if (!cloudDatabaseConfigured()) return null;
  if (!pool) {
    pool = new Pool({
      connectionString: process.env.NUBE_CLOUD_DATABASE_URL,
      ssl: sslConfig(),
      max: Number(process.env.NUBE_CLOUD_DATABASE_POOL_SIZE ?? 5),
    });
  }
  return pool;
}

export async function ensureCloudSchema() {
  const database = getCloudDatabasePool();
  if (!database) return false;
  if (schemaReady) return true;
  const schema = await readFile(new URL("./schema/cloud-postgres.sql", import.meta.url), "utf8");
  await database.query(schema);
  schemaReady = true;
  return true;
}

export async function ensureCloudProfile(user) {
  if (!cloudDatabaseEnabledFor(user)) return false;
  await ensureCloudSchema();
  const database = getCloudDatabasePool();
  await database.query(`
    insert into nube_profiles (
      user_id, email, name, avatar_url, currency, city, location_label, latitude, longitude, updated_at
    ) values ($1, $2, $3, $4, $5, $6, $7, $8, $9, now())
    on conflict (user_id) do update set
      email = excluded.email,
      name = excluded.name,
      avatar_url = coalesce(nube_profiles.avatar_url, excluded.avatar_url),
      currency = coalesce(nube_profiles.currency, excluded.currency),
      city = coalesce(excluded.city, nube_profiles.city),
      location_label = coalesce(excluded.location_label, nube_profiles.location_label),
      latitude = coalesce(excluded.latitude, nube_profiles.latitude),
      longitude = coalesce(excluded.longitude, nube_profiles.longitude),
      updated_at = now()
  `, [
    user.id,
    user.email ?? "",
    user.name ?? "Nube user",
    user.avatarUrl ?? user.picture ?? null,
    user.profile?.currency ?? user.currency ?? "EUR",
    user.profile?.city ?? user.city ?? null,
    user.profile?.locationLabel ?? user.locationLabel ?? null,
    Number.isFinite(Number(user.profile?.latitude ?? user.latitude)) ? Number(user.profile?.latitude ?? user.latitude) : null,
    Number.isFinite(Number(user.profile?.longitude ?? user.longitude)) ? Number(user.profile?.longitude ?? user.longitude) : null,
  ]);
  return true;
}

const parsePayload = (payload) => {
  if (!payload) return null;
  return typeof payload === "string" ? JSON.parse(payload) : payload;
};

const captureDueAt = (capture) => {
  if (!capture?.due) return null;
  const date = new Date(capture.due);
  return Number.isNaN(date.getTime()) ? null : date.toISOString();
};

export async function readCloudVault(user, sanitizeCapture) {
  if (!cloudDatabaseEnabledFor(user)) return null;
  await ensureCloudProfile(user);
  const database = getCloudDatabasePool();
  const rows = await database.query(`
    select payload
    from nube_captures
    where user_id = $1
    order by created_at desc, id desc
  `, [user.id]);
  return {
    app: "Nube",
    captures: rows.rows.map((row) => sanitizeCapture(parsePayload(row.payload))).filter(Boolean),
    focusText: "",
    updatedAt: new Date().toISOString(),
    storage: "cloud-postgres",
  };
}

export async function readCloudRecentCaptures(user, limit, sanitizeCapture) {
  if (!cloudDatabaseEnabledFor(user)) return null;
  await ensureCloudProfile(user);
  const safeLimit = Math.min(Math.max(Number(limit) || 30, 1), 80);
  const database = getCloudDatabasePool();
  const rows = await database.query(`
    select payload
    from nube_captures
    where user_id = $1
    order by created_at desc, id desc
    limit $2
  `, [user.id, safeLimit]);
  return rows.rows.map((row) => sanitizeCapture(parsePayload(row.payload))).filter(Boolean);
}

export async function writeCloudVault(user, data, sanitizeCapture) {
  if (!cloudDatabaseEnabledFor(user)) return null;
  await ensureCloudProfile(user);
  const database = getCloudDatabasePool();
  const client = await database.connect();
  const updatedAt = new Date().toISOString();
  try {
    await client.query("begin");
    await client.query("delete from nube_captures where user_id = $1", [user.id]);
    for (const rawCapture of data.captures) {
      const capture = sanitizeCapture(rawCapture);
      await client.query(`
        insert into nube_captures (
          id, user_id, title, body, type, source, priority, due_at, completed, starred, metadata, payload, created_at, updated_at
        ) values ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11::jsonb, $12::jsonb, $13, now())
        on conflict (user_id, id) do update set
          title = excluded.title,
          body = excluded.body,
          type = excluded.type,
          source = excluded.source,
          priority = excluded.priority,
          due_at = excluded.due_at,
          completed = excluded.completed,
          starred = excluded.starred,
          metadata = excluded.metadata,
          payload = excluded.payload,
          updated_at = now()
      `, [
        capture.id,
        user.id,
        capture.title ?? "Untitled capture",
        capture.text ?? "",
        capture.type ?? "Idea",
        capture.source ?? "universal input",
        capture.priority ?? null,
        captureDueAt(capture),
        Boolean(capture.completed),
        Boolean(capture.starred),
        JSON.stringify(capture.metadata ?? []),
        JSON.stringify(capture),
        capture.createdAt ?? updatedAt,
      ]);
    }
    await client.query("commit");
  } catch (error) {
    await client.query("rollback");
    throw error;
  } finally {
    client.release();
  }
  return { app: "Nube", captures: data.captures, focusText: data.focusText ?? "", updatedAt, storage: "cloud-postgres" };
}

export async function upsertCloudCapture(user, capture, sanitizeCapture) {
  if (!cloudDatabaseEnabledFor(user)) return null;
  await ensureCloudProfile(user);
  const cleanCapture = sanitizeCapture(capture);
  const database = getCloudDatabasePool();
  await database.query(`
    insert into nube_captures (
      id, user_id, title, body, type, source, priority, due_at, completed, starred, metadata, payload, created_at, updated_at
    ) values ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11::jsonb, $12::jsonb, $13, now())
    on conflict (user_id, id) do update set
      title = excluded.title,
      body = excluded.body,
      type = excluded.type,
      source = excluded.source,
      priority = excluded.priority,
      due_at = excluded.due_at,
      completed = excluded.completed,
      starred = excluded.starred,
      metadata = excluded.metadata,
      payload = excluded.payload,
      updated_at = now()
  `, [
    cleanCapture.id,
    user.id,
    cleanCapture.title ?? "Untitled capture",
    cleanCapture.text ?? "",
    cleanCapture.type ?? "Idea",
    cleanCapture.source ?? "universal input",
    cleanCapture.priority ?? null,
    captureDueAt(cleanCapture),
    Boolean(cleanCapture.completed),
    Boolean(cleanCapture.starred),
    JSON.stringify(cleanCapture.metadata ?? []),
    JSON.stringify(cleanCapture),
    cleanCapture.createdAt ?? new Date().toISOString(),
  ]);
  return cleanCapture;
}

export async function deleteCloudCapturesByIds(user, ids) {
  if (!cloudDatabaseEnabledFor(user)) return null;
  await ensureCloudProfile(user);
  const safeIds = Array.from(new Set(ids.map(Number).filter(Number.isFinite)));
  if (!safeIds.length) return 0;
  const database = getCloudDatabasePool();
  const result = await database.query("delete from nube_captures where user_id = $1 and id = any($2::bigint[])", [user.id, safeIds]);
  return result.rowCount ?? 0;
}

export const cloudDatabaseStatus = () => ({
  configured: cloudDatabaseConfigured(),
  provider: cloudDatabaseConfigured() ? cloudDatabaseProvider() : null,
  mode: cloudDatabaseConfigured() ? "cloud-ready" : "local-only",
  requiredEnv: ["NUBE_CLOUD_DATABASE_URL", "NUBE_CLOUD_DATABASE_PROVIDER", "NUBE_CLOUD_DATABASE_SSL"],
  schema: "server/schema/cloud-postgres.sql",
});
