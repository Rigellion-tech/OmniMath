import { handleExplainImageRequest } from "../server/app.js";
import { waitUntil } from "@vercel/functions";

export const config = {
  api: {
    bodyParser: false,
  },
};

export default function handler(req, res) {
  const operation = handleExplainImageRequest(req, res);
  if (process.env.VERCEL === "1") waitUntil(operation);
  return operation;
}
