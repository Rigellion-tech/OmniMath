import { handleExplainTokenRequest } from "../server/app.js";

export default function handler(req, res) {
  return handleExplainTokenRequest(req, res);
}
