import { handleCurrentUserRequest } from "../server/app.js";

export default function handler(req, res) {
  return handleCurrentUserRequest(req, res);
}
