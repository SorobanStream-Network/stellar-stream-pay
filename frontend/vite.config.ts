import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";

// https://vitejs.dev/config/
export default defineConfig({
  plugins: [react()],
  build: {
    // @stellar/stellar-sdk uses native BigInt; keep the target at ES2020+.
    target: "es2020",
  },
  server: {
    port: 5173,
  },
});
