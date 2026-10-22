import { existsSync, readFileSync } from "node:fs";
import { resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { defineConfig, type Plugin } from "vite";
import react from "@vitejs/plugin-react";
import { VitePWA } from "vite-plugin-pwa";
import { parseSiteConfig } from "./src/app/site-config-schema";

const defaultSiteConfigPath = fileURLToPath(
  new URL("./site.config.local.json", import.meta.url),
);
const gameManifestSchemaPath = fileURLToPath(
  new URL(
    "../../docs/game-integration/game-manifest-v1.schema.json",
    import.meta.url,
  ),
);
const gameManifestSchemaRoute = "/schemas/game-manifest-v1.json";

function shareImageOrigin(): Plugin {
  let origin = "";
  return {
    name: "playweft-share-image-origin",
    configResolved(config) {
      const configured = config.env.VITE_SITE_ORIGIN?.trim();
      if (!configured) return;
      const url = new URL(configured);
      if (
        !["http:", "https:"].includes(url.protocol) ||
        url.username || url.password ||
        url.pathname !== "/" || url.search || url.hash
      ) {
        throw new Error("VITE_SITE_ORIGIN must be an HTTP(S) origin, such as https://play.example.com");
      }
      origin = url.origin;
    },
    transformIndexHtml(html) {
      return origin
        ? html.replaceAll(
            'content="/icons/pwa-512.png"',
            `content="${origin}/icons/pwa-512.png"`,
          )
        : html;
    },
  };
}

function gameManifestSchema(): Plugin {
  const readSchema = () => readFileSync(gameManifestSchemaPath, "utf8");
  return {
    name: "playweft-game-manifest-schema",
    configureServer(server) {
      server.middlewares.use((request, response, next) => {
        const pathname = new URL(request.url ?? "/", "http://localhost")
          .pathname;
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

function embeddedSiteConfig() {
  const configuredPath = process.env.PLAYWEFT_SITE_CONFIG_FILE;
  const filePath = configuredPath
    ? resolve(process.env.INIT_CWD ?? process.cwd(), configuredPath)
    : defaultSiteConfigPath;
  if (!existsSync(filePath)) {
    if (configuredPath) throw new Error(`Site config file does not exist: ${filePath}`);
    return parseSiteConfig({});
  }
  try {
    return parseSiteConfig(JSON.parse(readFileSync(filePath, "utf8")));
  } catch (error) {
    throw new Error(`Could not load site config ${filePath}: ${error instanceof Error ? error.message : String(error)}`);
  }
}

export default defineConfig({
  resolve: {
    alias: {
      "@": fileURLToPath(new URL("./src", import.meta.url)),
    },
  },
  plugins: [
    react(),
    shareImageOrigin(),
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
        // Lua is requested only by the simulation host, not downloaded on SW install.
        globIgnores: ["**/lua-runtime-*.js"],
      },
    }),
  ],
  define: {
    __PLAYWEFT_SITE_CONFIG__: JSON.stringify(embeddedSiteConfig()),
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
