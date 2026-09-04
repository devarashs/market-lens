/// <reference types="vitest/config" />
import react from "@vitejs/plugin-react";
import tailwindcss from "@tailwindcss/vite";
import { defineConfig } from "vite";

// Prod serving stays with the Python collector (it serves app/dist), so the
// dev server only exists for HMR — it proxies data routes to a collector.
// Defaults to a local one on 8899; LENS_COLLECTOR points it at any other
// instance (a second local one on LENS_PORT, or a remote deployment).
export default defineConfig(() => {
  const collector = process.env.LENS_COLLECTOR ?? "http://127.0.0.1:8899";
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
          ["/klines", "/symbol-info", "/stablecoins", "/api"].map(
            route => [route, { target: collector, changeOrigin: remote }])),
      },
    },
    test: {
      environment: "node",
      include: ["src/**/*.test.ts"],
    },
  };
});
