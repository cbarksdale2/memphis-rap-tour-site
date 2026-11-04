// Photo storage. Bytes live in Workers KV (free tier) because R2 is not enabled on this account;
// switching to R2 later means changing put/get/del here only. The admin page resizes photos in the
// browser to at most 2000px before upload, which also strips location data from phone photos.
import type { Content } from "./content";
import { now } from "./http";

export const MAX_BYTES = 5 * 1024 * 1024;
export const TYPES: Record<string, string> = { "image/jpeg": "jpg", "image/png": "png", "image/webp": "webp" };

export interface ImageRecord {
  id: string;
  storage: string;
  content_type: string;
  bytes: number;
  width: number;
  height: number;
  alt: string;
  created_at: number;
  updated_at: number;
  deleted_at: number | null;
}

/** The real type from the first bytes, never from the file name or the browser's claim. */
export function sniff(b: Uint8Array): string | null {
  if (b[0] === 0xff && b[1] === 0xd8 && b[2] === 0xff) return "image/jpeg";
  if (b[0] === 0x89 && b[1] === 0x50 && b[2] === 0x4e && b[3] === 0x47) return "image/png";
  if (b[0] === 0x52 && b[1] === 0x49 && b[2] === 0x46 && b[3] === 0x46 && b[8] === 0x57 && b[9] === 0x45 && b[10] === 0x42 && b[11] === 0x50) return "image/webp";
  return null;
}

export function dimensions(b: Uint8Array, type: string): { width: number; height: number } {
  const dv = new DataView(b.buffer, b.byteOffset, b.byteLength);
  try {
    if (type === "image/png") return { width: dv.getUint32(16), height: dv.getUint32(20) };
    if (type === "image/jpeg") {
      let i = 2;
      while (i < b.length - 9) {
        if (b[i] !== 0xff) { i++; continue; }
        const marker = b[i + 1];
        const len = dv.getUint16(i + 2);
        if (marker >= 0xc0 && marker <= 0xcf && ![0xc4, 0xc8, 0xcc].includes(marker)) {
          return { height: dv.getUint16(i + 5), width: dv.getUint16(i + 7) };
        }
        i += 2 + len;
      }
    }
    if (type === "image/webp") {
      const chunk = String.fromCharCode(b[12], b[13], b[14], b[15]);
      if (chunk === "VP8X") return { width: 1 + (b[24] | (b[25] << 8) | (b[26] << 16)), height: 1 + (b[27] | (b[28] << 8) | (b[29] << 16)) };
      if (chunk === "VP8 ") return { width: dv.getUint16(26, true) & 0x3fff, height: dv.getUint16(28, true) & 0x3fff };
      if (chunk === "VP8L") {
        const bits = dv.getUint32(21, true);
        return { width: (bits & 0x3fff) + 1, height: ((bits >> 14) & 0x3fff) + 1 };
      }
    }
  } catch {
    /* fall through */
  }
  return { width: 0, height: 0 };
}

export type UploadCheck = { ok: true; type: string; bytes: Uint8Array; width: number; height: number } | { ok: false; error: string };

export async function checkUpload(file: unknown, altRaw: unknown): Promise<UploadCheck> {
  const alt = String(altRaw ?? "").trim();
  if (!alt) return { ok: false, error: "Describe the photo in a few words first (for people using screen readers and for Google)." };
  if (alt.length > 300) return { ok: false, error: "Keep the description under 300 characters." };
  if (!file || typeof file === "string" || !(file as File).size) return { ok: false, error: "Choose a photo first." };
  const f = file as File;
  if (f.size > MAX_BYTES) return { ok: false, error: "That photo is over 5 MB. Try a smaller one." };
  const bytes = new Uint8Array(await f.arrayBuffer());
  const type = sniff(bytes);
  if (!type) return { ok: false, error: "That file isn't a JPEG, PNG or WebP photo. iPhone photos are converted for you when you pick them here." };
  return { ok: true, type, bytes, ...dimensions(bytes, type) };
}

function newKey(id: string, type: string): string {
  return `${id}-${Date.now().toString(36)}.${TYPES[type]}`;
}

export async function storeImage(kv: KVNamespace, id: string, c: Extract<UploadCheck, { ok: true }>): Promise<string> {
  const key = newKey(id, c.type);
  await kv.put(key, c.bytes, { metadata: { type: c.type } });
  return `kv:${key}`;
}

export async function readImage(kv: KVNamespace, key: string): Promise<{ body: ArrayBuffer; type: string } | null> {
  const r = await kv.getWithMetadata<{ type: string }>(key, "arrayBuffer");
  if (!r.value) return null;
  return { body: r.value, type: r.metadata?.type || "application/octet-stream" };
}

export async function dropBytes(kv: KVNamespace, storage: string): Promise<void> {
  if (storage.startsWith("kv:")) await kv.delete(storage.slice(3));
}

/** Where a photo is used, as "Page name: section heading" lines, in the draft and the live site. */
export function usage(c: Content, id: string): string[] {
  const out: string[] = [];
  for (const p of c.pages) {
    for (const s of p.sections) {
      const ids = [s.data.image, ...(s.data.images || "").split(",")].map((x) => (x || "").trim());
      if (ids.includes(id)) out.push(`${p.nav_label}: ${s.data.heading || s.data.label || "top of page"}`);
    }
  }
  return out;
}

export async function listImages(db: D1Database, includeDeleted = false): Promise<ImageRecord[]> {
  const r = await db
    .prepare(`SELECT * FROM images ${includeDeleted ? "" : "WHERE deleted_at IS NULL"} ORDER BY created_at DESC`)
    .all<ImageRecord>();
  return r.results;
}

export function newImageId(): string {
  const b = crypto.getRandomValues(new Uint8Array(6));
  return "img" + [...b].map((x) => x.toString(16).padStart(2, "0")).join("");
}

export { now };
