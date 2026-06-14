import { handleSolveExtractedProblemRequest } from "../server/app.js";

export default function handler(req, res) {
  return handleSolveExtractedProblemRequest(req, res);
}
