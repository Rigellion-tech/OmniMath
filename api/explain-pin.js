import { handleExplainPinRequest } from "../server/app.js";

export default function handler(req, res) {
  return handleExplainPinRequest(req, res);
}
