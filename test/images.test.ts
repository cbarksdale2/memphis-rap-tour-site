// Photos: alt text required, real image types only, stored and served, in-use photos can't be removed,
// removed photos can be brought back.
import { SELF } from "cloudflare:test";
import { env } from "cloudflare:workers";
import { describe, expect, it } from "vitest";
import { BASE, csrfOf, flash, get, owner, post } from "./helpers";

// A 1x1 PNG.
const PNG = Uint8Array.from(atob("iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg=="), (c) => c.charCodeAt(0));

async function upload(cookie: string, alt: string | null, bytes: Uint8Array = PNG, name = "pic.png") {
  const fd = new FormData();
  fd.append("file", new File([bytes], name, { type: "image/png" }));
  if (alt !== null) fd.append("alt", alt);
  fd.append("csrf", await csrfOf(cookie, "/admin/images"));
  return post(cookie, "/admin/images", fd, { csrf: null });
}

describe("photo upload", () => {
  it("refuses a photo with no description and stores nothing", async () => {
    const { cookie } = await owner();
    await get(cookie, "/admin"); // seed the shipped photos first
    const before = (await env.DB.prepare("SELECT COUNT(*) AS n FROM images").first<{ n: number }>())!.n;
    const res = await upload(cookie, "   ");
    expect(flash(res)).toContain("Describe the photo");
    const res2 = await upload(cookie, null);
    expect(flash(res2)).toContain("Describe the photo");
    const after = (await env.DB.prepare("SELECT COUNT(*) AS n FROM images").first<{ n: number }>())!.n;
    expect(after).toBe(before);
  });

  it("refuses a file that isn't really an image, whatever its name says", async () => {
    const { cookie } = await owner();
    const res = await upload(cookie, "A photo", new TextEncoder().encode("<svg onload=alert(1)>"), "evil.png");
    expect(flash(res)).toContain("isn't a JPEG, PNG or WebP");
  });

  it("stores a described photo, serves it, and reads its size", async () => {
    const { cookie } = await owner();
    const res = await upload(cookie, "Riders at the Young Dolph mural");
    expect(flash(res)).toContain("Uploaded");
    const im = await env.DB.prepare("SELECT * FROM images WHERE alt = 'Riders at the Young Dolph mural'").first<any>();
    expect(im.width).toBe(1);
    expect(im.height).toBe(1);
    const key = im.storage.slice(3);
    const served = await SELF.fetch(`${BASE}/img/${key}`);
    expect(served.status).toBe(200);
    expect(served.headers.get("Content-Type")).toBe("image/png");
    expect(new Uint8Array(await served.arrayBuffer())).toEqual(PNG);
  });

  it("won't remove a photo that a page uses, and says where", async () => {
    const { cookie } = await owner();
    await get(cookie, "/admin"); // seed
    const res = await post(cookie, "/admin/images/mural/delete", {}, { csrf: await csrfOf(cookie, "/admin/images") });
    expect(flash(res)).toContain("still used on: Home");
    const row = await env.DB.prepare("SELECT deleted_at FROM images WHERE id = 'mural'").first<any>();
    expect(row.deleted_at).toBeNull();
  });

  it("removes an unused photo and can bring it back", async () => {
    const { cookie } = await owner();
    await upload(cookie, "Spare photo to remove");
    const im = await env.DB.prepare("SELECT id FROM images WHERE alt = 'Spare photo to remove'").first<any>();
    const res = await post(cookie, `/admin/images/${im.id}/delete`, {}, { csrf: await csrfOf(cookie, "/admin/images") });
    expect(flash(res)).toContain("Photo removed");
    expect((await env.DB.prepare("SELECT deleted_at FROM images WHERE id = ?").bind(im.id).first<any>()).deleted_at).not.toBeNull();
    await post(cookie, `/admin/images/${im.id}/restore`, {}, { csrf: await csrfOf(cookie, "/admin/images") });
    expect((await env.DB.prepare("SELECT deleted_at FROM images WHERE id = ?").bind(im.id).first<any>()).deleted_at).toBeNull();
  });
});
