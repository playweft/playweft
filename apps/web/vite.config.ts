import { existsSync, readFileSync } from "node:fs";
import { resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { defineConfig, type Plugin } from "vite";
import react from "@vitejs/plugin-react";
import { VitePWA } from "vite-plugin-pwa";

const defaultFeaturedGamesPath = fileURLToPath(
  new URL("./featured-games.local.json", import.meta.url),
);
const gameManifestSchemaPath = fileURLToPath(
  new URL(
    "../../docs/game-integration/game-manifest-v1.schema.json",
    import.meta.url,
  ),
);
const gameManifestSchemaRoute = "/schemas/game-manifest-v1.json";

function gameManifestSchema(): Plugin {
  const readSchema = () => readFileSync(gameManifestSchemaPath, "utf8");
  return {
    name: "playweft-game-manifest-schema",
    configureServer(server) {
      server.middlewares.use((request, response, next) => {
        const pathname = new URL(
          request.url ?? "/",
          "http://localhost",
        ).pathname;
        if (pathname !== gameManifestSchemaRoute) return next();
        response.statusCode = 200;
        response.setHeader(
          "Content-Type",
          "application/schema+json; charset=utf-8",
        );
        response.end(readSchema());
      });
    },
    generateBundle() {
      this.emitFile({
        type: "asset",
        fileName: gameManifestSchemaRoute.slice(1),
        source: readSchema(),
      });
    },
  };
}

function embeddedFeaturedGameSources(): unknown[] | null {
  const configuredPath = process.env.PLAYWEFT_FEATURED_GAMES_FILE;
  const filePath = configuredPath
    ? resolve(process.env.INIT_CWD ?? process.cwd(), configuredPath)
    : defaultFeaturedGamesPath;
  if (!existsSync(filePath)) {
    if (configuredPath) {
      throw new Error(`Featured-games file does not exist: ${filePath}`);
    }
    return null;
  }

  let value: unknown;
  try {
    value = JSON.parse(readFileSync(filePath, "utf8"));
  } catch (error) {
    throw new Error(
      `Could not parse featured-games file ${filePath}: ${
        error instanceof Error ? error.message : String(error)
      }`,
    );
  }
  if (
    !Array.isArray(value) ||
    value.some((item) => {
      if (item === null || typeof item !== "object" || Array.isArray(item))
        return true;
      const source = item as Record<string, unknown>;
      const hasGame =
        typeof source.manifestUrl === "string" &&
        source.manifestUrl.trim().length > 0;
      const hasList =
        typeof source.listUrl === "string" &&
        source.listUrl.trim().length > 0;
      return hasGame === hasList;
    })
  ) {
    throw new Error(
      `Featured-games file ${filePath} must contain { manifestUrl } or { listUrl } entries`,
    );
  }
  return value;
}

export default defineConfig({
  resolve: {
    alias: {
      "@": fileURLToPath(new URL("./src", import.meta.url)),
    },
  },
  plugins: [
    react(),
    gameManifestSchema(),
    VitePWA({
      strategies: "injectManifest",
      srcDir: "src",
      filename: "service-worker.ts",
      registerType: "prompt",
      injectRegister: false,
      manifest: false,
      injectManifest: {
        globPatterns: ["**/*.{html,js,css,svg,png,webmanifest}"],
      },
    }),
  ],
  define: {
    __PLAYWEFT_FEATURED_GAME_SOURCES__: JSON.stringify(
      embeddedFeaturedGameSources(),
    ),
  },
  server: {
    port: 9133,
    proxy: {
      "/api": {
        target: "http://127.0.0.1:8787",
        ws: true,
      },
    },
  },
});
