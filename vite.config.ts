import { readFileSync } from "node:fs";
import react from "@vitejs/plugin-react";
import { defineConfig } from "vite";

const graphFile = process.env.SOURCEBETA_GRAPH;

export default defineConfig({
  plugins: [
    react(),
    {
      name: "sourcebeta-project",
      configureServer(server) {
        server.middlewares.use("/api/sourcebeta/project", (_request, response) => {
          if (!graphFile) {
            response.statusCode = 404;
            response.end("No project graph configured");
            return;
          }
          response.setHeader("Content-Type", "application/json");
          response.end(readFileSync(graphFile, "utf8"));
        });
      },
    },
  ],
});
