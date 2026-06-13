import { handleSessionsRequest } from "../server/app.js";

export default function handler(req, res) {
  return handleSessionsRequest(req, res);
}
