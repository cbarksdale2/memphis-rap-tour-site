import type { D1Migration } from "@cloudflare/vitest-plugin";
declare global {
  namespace Cloudflare {
    interface Env {
      DB: D1Database;
      IMAGES: KVNamespace;
      BACKUPS: KVNamespace;
      ASSETS: Fetcher;
      UNSUB_SECRET: string;
      IP_SALT: string;
      CANONICAL_HOST: string;
      TEST_MIGRATIONS: D1Migration[];
    }
  }
}
export {};
