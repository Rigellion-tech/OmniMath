import http from "node:http";
import { pathToFileURL } from "node:url";
import { handleApiRequest } from "./app.js";

const PORT = Number(process.env.PORT || 8787);

export function createServer() {
  return http.createServer(handleApiRequest);
}

const isDirectRun = process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href;

if (isDirectRun) {
  createServer().listen(PORT, () => {
    console.log(`OmniMath API server listening on http://localhost:${PORT}`);
  });
}
