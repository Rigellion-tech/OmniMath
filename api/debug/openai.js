import { handleOpenAiDebugRequest } from "../../server/app.js";

export default function handler(req, res) {
  return handleOpenAiDebugRequest(req, res);
}
