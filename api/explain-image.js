import { handleExplainImageRequest } from "../server/app.js";

export const config = {
  api: {
    bodyParser: false,
  },
};

export default function handler(req, res) {
  return handleExplainImageRequest(req, res);
}
