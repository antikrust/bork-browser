import process from "node:process";
import { readFileSync } from "node:fs";
import { defineConfig } from "vite";
import tailwindcss from "@tailwindcss/vite";
import react from "@vitejs/plugin-react-swc";
import tsconfigPaths from "vite-tsconfig-paths";
import { genJarmnPlugin } from "../../libs/vite-plugin-gen-jarmn/plugin.ts";
import { disableCspInDevPlugin } from "../../libs/vite-plugin-disable-csp/plugin.ts";

/**
 * The shipping version, straight from the root package.json — the single source
 * the release script, the update manifest and the download site all use. Built
 * in so the welcome/What's New page can name the real version instead of the
 * hardcoded "12" it used to fall back to.
 */
const BORK_VERSION: string = JSON.parse(
  readFileSync(new URL("../../package.json", import.meta.url), "utf8"),
).version;

export default defineConfig(({ command }) => {
  if (command === "serve") process.env.NODE_ENV = "development";
  return {
  define: {
    __BORK_VERSION__: JSON.stringify(BORK_VERSION),
  },
  build: {
    outDir: "_dist",
  },
  plugins: [
    tailwindcss(),
    react({
      jsxImportSource: "react",
    }),
    tsconfigPaths(),
    genJarmnPlugin("content-welcome", "noraneko-welcome", "content"),
    disableCspInDevPlugin(command === "serve"),
  ],
  optimizeDeps: {
    include: ["react", "react-dom", "react/jsx-runtime"],
  },
  server: {
    hmr: {
      overlay: true,
    },
  },
  };
});
