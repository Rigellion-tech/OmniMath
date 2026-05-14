import { handleHealthRequest } from "../server/app.js";

export default function handler(req, res) {
  return handleHealthRequest(req, res);
}
