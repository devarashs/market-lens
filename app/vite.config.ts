/// <reference types="vitest/config" />
import react from "@vitejs/plugin-react";
import tailwindcss from "@tailwindcss/vite";
import { defineConfig } from "vite";

// Prod serving stays with the Python collector (it serves app/dist), so the
// dev server only exists for HMR — it proxies data routes to a collector.
// Defaults to a local one on 8899. `npm run dev:vps` points it at the
// deployed collector instead, which is how you get live cross-venue flow
// (and real liquidations) without running a collector locally;
// LENS_COLLECTOR overrides the target for anything else.
const DEPLOYED = "https://market-lens.runsudo.net";

export default defineConfig(({ mode }) => {
  const collector = mode === "vps"
    ? DEPLOYED
    : process.env.LENS_COLLECTOR ?? "http://127.0.0.1:8899";
  const remote = !collector.includes("127.0.0.1");
  return {
    plugins: [react(), tailwindcss()],
    server: {
      proxy: {
        "/ws": {
          target: collector.replace(/^http/, "ws"),
          ws: true, changeOrigin: remote,
        },
        // Every JSON route the app fetches. /symbol-info and /stablecoins
        // were missing and 404'd in dev, which is only survivable because
        // both panels degrade quietly.
        ...Object.fromEntries(
          ["/klines", "/symbol-info", "/stablecoins", "/markets"].map(
            route => [route, { target: collector, changeOrigin: remote }])),
      },
    },
    test: {
      environment: "node",
      include: ["src/**/*.test.ts"],
    },
  };
});
