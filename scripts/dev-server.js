import { loadEnvFiles } from "../server/env.js";

loadEnvFiles();
if (!process.env.NODE_ENV) process.env.NODE_ENV = "development";

const { createServer } = await import("../server/index.js");
const port = Number(process.env.PORT || 8787);

createServer().listen(port, () => {
  console.log(`OmniMath API server listening on http://localhost:${port}`);
});
