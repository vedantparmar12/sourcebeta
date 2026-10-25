import { readFileSync } from "node:fs";
import { isIP } from "node:net";
import react from "@vitejs/plugin-react";
import { defineConfig } from "vite";

const graphFile = process.env.SOURCEBETA_GRAPH;
const LOOPBACK_HOSTS = new Set(["localhost", "127.0.0.1", "::1"]);

function hostname(value: string | undefined): string {
  if (!value) return "";
  try {
    return new URL(`http://${value}`).hostname.replace(/^\[|\]$/g, "").toLowerCase();
  } catch {
    return "";
  }
}

function loopbackAddress(value: string | undefined): boolean {
  if (!value) return false;
  const address = value.replace(/^::ffff:/, "");
  return address === "::1" || (isIP(address) === 4 && address.startsWith("127."));
}

export default defineConfig({
  plugins: [
    react(),
    {
      name: "sourcebeta-project",
      configureServer(server) {
        server.middlewares.use("/api/sourcebeta/project", (request, response) => {
          if (request.method !== "GET") {
            response.setHeader("Allow", "GET");
            response.statusCode = 405;
            response.end("Method not allowed");
            return;
          }
          if (!loopbackAddress(request.socket.remoteAddress) || !LOOPBACK_HOSTS.has(hostname(request.headers.host))) {
            response.statusCode = 403;
            response.end("Sourcebeta project data is available only on loopback");
            return;
          }
          if (!graphFile) {
            response.statusCode = 404;
            response.end("No project graph configured");
            return;
          }
          response.setHeader("Cache-Control", "no-store");
          response.setHeader("X-Content-Type-Options", "nosniff");
          response.setHeader("Content-Type", "application/json");
          try {
            response.end(readFileSync(graphFile, "utf8"));
          } catch {
            response.statusCode = 500;
            response.end("Project graph is unavailable");
          }
        });
      },
    },
  ],
});
