import { handleSolveExtractedProblemRequest } from "../server/app.js";
import { waitUntil } from "@vercel/functions";

export default function handler(req, res) {
  const operation = handleSolveExtractedProblemRequest(req, res);
  if (process.env.VERCEL === "1") waitUntil(operation);
  return operation;
}
