import { handleExplainRequest } from "../server/app.js";

export default function handler(req, res) {
  return handleExplainRequest(req, res);
}
