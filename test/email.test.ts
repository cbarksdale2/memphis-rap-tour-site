// The mailer sends through Gmail when the Google secrets exist, and says plainly when it can't.
import { afterEach, describe, expect, it } from "vitest";
import { googleHttp, mailer } from "../src/email";

const realFetch = googleHttp.fetch;
afterEach(() => { googleHttp.fetch = realFetch; });

const MAIL = { to: "rider@example.org", replyTo: "team@memphisraptour.com", subject: "Tomorrow: Memphis Rap Tour", text: "Hi Rider,\n\nSee you tomorrow." };
const decode = (raw: string) => new TextDecoder().decode(Uint8Array.from(atob(raw.replace(/-/g, "+").replace(/_/g, "/")), (ch) => ch.charCodeAt(0)));

describe("mailer", () => {
  it("reports 'email not set up yet' with no secrets, sends via Gmail with them, and names a refused sign-in", async () => {
    const calls: { url: string; init: RequestInit }[] = [];
    googleHttp.fetch = async (url, init) => { calls.push({ url, init }); throw new Error("must not be called"); };
    expect(await mailer.send({} as any, MAIL)).toEqual({ sent: false, reason: "email not set up yet" });
    expect(calls).toHaveLength(0);

    const env = { GOOGLE_CLIENT_ID: "cid", GOOGLE_CLIENT_SECRET: "csecret", GOOGLE_REFRESH_TOKEN: "refresh-aaaaaaaaaaaa" } as any;
    googleHttp.fetch = async (url, init) => {
      calls.push({ url, init });
      if (url === "https://oauth2.googleapis.com/token") return Response.json({ access_token: "at-1", expires_in: 3599 });
      return Response.json({ id: "m1" });
    };
    expect(await mailer.send(env, MAIL)).toEqual({ sent: true });
    expect(calls.map((c) => c.url)).toEqual(["https://oauth2.googleapis.com/token", "https://gmail.googleapis.com/gmail/v1/users/me/messages/send"]);
    expect(String(calls[0].init.body)).toContain("grant_type=refresh_token");
    expect((calls[1].init.headers as any).Authorization).toBe("Bearer at-1");
    const msg = decode(JSON.parse(String(calls[1].init.body)).raw);
    expect(msg).toContain("From: Memphis Rap Tour <team@memphisraptour.com>");
    expect(msg).toContain("To: rider@example.org");
    expect(msg).toContain("Reply-To: team@memphisraptour.com");

    const refused = { ...env, GOOGLE_REFRESH_TOKEN: "refresh-bbbbbbbbbbbb" };
    googleHttp.fetch = async () => Response.json({ error: "invalid_grant", error_description: "Token has been expired or revoked." }, { status: 400 });
    const r = await mailer.send(refused, MAIL);
    expect(r.sent).toBe(false);
    expect((r as any).reason).toMatch(/invalid_grant.*google-auth\.mjs/);
  });
});
