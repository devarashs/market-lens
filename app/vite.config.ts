/// <reference types="vitest/config" />
import react from "@vitejs/plugin-react";
import tailwindcss from "@tailwindcss/vite";
import { defineConfig } from "vite";

// Prod serving stays with the Python collector (it serves app/dist), so the
// dev server only exists for HMR — it proxies data routes to the collector,
// which must be running on 8899 during `npm run dev`.
export default defineConfig({
  plugins: [react(), tailwindcss()],
  server: {
    proxy: {
      "/ws": { target: "ws://127.0.0.1:8899", ws: true },
      "/klines": { target: "http://127.0.0.1:8899" },
    },
  },
  test: {
    environment: "node",
    include: ["src/**/*.test.ts"],
  },
});
