// Daily job: back up the database to KV (keep 30) and tidy up. Lives outside index.ts because the main
// module may only export the Worker handler.
import { pointers } from "./content";
import { type Env, now } from "./http";

export interface FullEnv extends Env {
  BACKUPS: KVNamespace;
}


const BACKUP_TABLES = ["schema_version", "users", "settings", "images", "subscribers", "tour_requests", "audit", "counts", "recovery_codes", "tours", "bookings", "stripe_events"];
export const KEEP_BACKUPS = 30;

export async function dailyJob(env: FullEnv, t = now()): Promise<string> {
  const day = new Date(t * 1000).toISOString().slice(0, 10);
  const dump: Record<string, unknown[]> = {};
  for (const tb of BACKUP_TABLES) dump[tb] = (await env.DB.prepare(`SELECT * FROM ${tb}`).all()).results;
  const p = await pointers(env.DB);
  dump.versions = (await env.DB.prepare("SELECT * FROM versions WHERE id IN (?, ?) OR id > (SELECT MAX(id) - 200 FROM versions) ORDER BY id").bind(p.draft, p.published).all()).results;
  const body = JSON.stringify({ day, at: t, tables: dump });
  await env.BACKUPS.put(`backup:${day}`, body);
  const keys = (await env.BACKUPS.list({ prefix: "backup:" })).keys.map((k) => k.name).sort();
  const old = keys.slice(0, Math.max(0, keys.length - KEEP_BACKUPS));
  for (const k of old) await env.BACKUPS.delete(k);

  // Photos removed more than 30 days ago lose their stored bytes; attempts older than 2 days go.
  const gone = await env.DB.prepare("SELECT id, storage FROM images WHERE deleted_at IS NOT NULL AND deleted_at < ? AND storage LIKE 'kv:%'").bind(t - 30 * 86400).all<{ id: string; storage: string }>();
  for (const g of gone.results) {
    await env.IMAGES.delete(g.storage.slice(3));
    await env.DB.prepare("UPDATE images SET storage = 'gone:' || storage WHERE id = ?").bind(g.id).run();
  }
  await env.DB.batch([
    env.DB.prepare("DELETE FROM attempts WHERE at < ?").bind(t - 2 * 86400),
    env.DB.prepare("DELETE FROM sessions WHERE expires_at < ?").bind(t),
    env.DB.prepare("UPDATE bookings SET status = 'expired' WHERE status = 'held' AND hold_expires_at < ?").bind(t - 3600),
    env.DB.prepare("DELETE FROM password_resets WHERE expires_at < ?").bind(t),
  ]);
  const rows = Object.values(dump).reduce((n, r) => n + r.length, 0);
  const census = `backup ${day}: ${rows} rows, ${Math.round(body.length / 1024)} KB; kept ${Math.min(keys.length, KEEP_BACKUPS)}, removed ${old.length}; purged ${gone.results.length} photo(s)`;
  if (rows === 0) throw new Error(`NAMED STOP [BACKUP_EMPTY] ${census}: the backup read no rows, so it proves nothing. Check the D1 binding.`);
  console.log(census);
  return census;
}

