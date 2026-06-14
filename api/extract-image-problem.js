import { handleExtractImageProblemRequest } from "../server/app.js";

export const config = {
  api: {
    bodyParser: false,
  },
};

export default function handler(req, res) {
  return handleExtractImageProblemRequest(req, res);
}
