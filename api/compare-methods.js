import { handleCompareMethodsRequest } from "../server/app.js";

export default function handler(req, res) {
  return handleCompareMethodsRequest(req, res);
}
