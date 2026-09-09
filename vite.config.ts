import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";

export default defineConfig({
  plugins: [react()],
  // `public/` currently contains locally sourced PingFang binaries whose
  // embedded metadata forbids redistribution. Keep them out of every build;
  // the application uses the system font stack declared in theme.css.
  publicDir: false,
  clearScreen: false,
  server: { host: "127.0.0.1", port: 1427, strictPort: true },
  build: { target: "es2022" },
});
