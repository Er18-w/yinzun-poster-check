import react from "@vitejs/plugin-react";
import { defineConfig } from "vite";

export default defineConfig({
  base: "/yinzun-poster-check/",
  root: "github-pages-src",
  plugins: [react()],
  publicDir: "../public",
  build: {
    outDir: "../docs",
    emptyOutDir: true,
  },
});
