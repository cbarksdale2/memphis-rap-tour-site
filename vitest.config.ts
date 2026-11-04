import { defineConfig } from "vitest/config";
import { cloudflareTest, readD1Migrations } from "@cloudflare/vitest-plugin";

export default defineConfig(async () => {
  const migrations = await readD1Migrations("./migrations");
  return {
    plugins: [
      cloudflareTest({
        wrangler: { configPath: "./wrangler.toml" },
        miniflare: {
          bindings: { TEST_MIGRATIONS: migrations, UNSUB_SECRET: "test-unsub-secret-0123456789", IP_SALT: "test-ip-salt-0123456789" },
        },
      }),
    ],
    test: { setupFiles: ["./test/setup.ts"], testTimeout: 30000 },
  };
});
