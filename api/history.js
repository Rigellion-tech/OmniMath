import { handleHistoryRequest } from "../server/app.js";

export default function handler(req, res) {
  return handleHistoryRequest(req, res);
}
