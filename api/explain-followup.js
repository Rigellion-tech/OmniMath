import { handleExplainFollowupRequest } from "../server/app.js";

export default function handler(req, res) {
  return handleExplainFollowupRequest(req, res);
}
