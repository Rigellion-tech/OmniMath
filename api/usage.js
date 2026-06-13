import { handleUsageRequest } from "../server/app.js";

export default function handler(req, res) {
  return handleUsageRequest(req, res);
}
