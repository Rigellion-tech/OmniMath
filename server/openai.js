import { assertMathExplanation, mathExplanationSchema } from "./mathExplanationSchema.js";

const OPENAI_RESPONSES_URL = "https://api.openai.com/v1/responses";
const DEFAULT_MODEL = "gpt-5.5";

function getApiKey() {
  const apiKey = process.env.OPENAI_API_KEY;
  if (!apiKey) {
    throw Object.assign(new Error("OPENAI_API_KEY is not configured on the server."), {
      statusCode: 500,
      code: "SERVER_CONFIG_ERROR",
      publicMessage: "The AI backend is not configured.",
    });
  }
  return apiKey;
}

export function assertOpenAiConfigured() {
  getApiKey();
}

function extractOutputText(responseBody) {
  if (typeof responseBody.output_text === "string") return responseBody.output_text;

  for (const item of responseBody.output || []) {
    for (const content of item.content || []) {
      if (typeof content.text === "string") return content.text;
    }
  }

  const refusal = responseBody.output
    ?.flatMap((item) => item.content || [])
    ?.find((content) => content.refusal)?.refusal;

  if (refusal) {
    throw Object.assign(new Error(refusal), {
      statusCode: 502,
      code: "AI_REQUEST_REFUSED",
      publicMessage: "The AI service declined to complete that explanation.",
    });
  }

  throw Object.assign(new Error("OpenAI response did not include text output."), {
    statusCode: 502,
    code: "AI_RESPONSE_INVALID",
    publicMessage: "The AI service returned an incomplete explanation.",
  });
}

function parseExplanation(responseBody) {
  const outputText = extractOutputText(responseBody);
  try {
    return assertMathExplanation(JSON.parse(outputText));
  } catch (error) {
    if (error.statusCode) throw error;
    throw Object.assign(new Error("OpenAI returned malformed JSON."), {
      statusCode: 502,
      code: "AI_RESPONSE_INVALID",
      publicMessage: "The AI service returned an invalid explanation.",
    });
  }
}

export async function createMathExplanation({ prompt, image }) {
  const content = [{ type: "input_text", text: prompt }];
  if (image) {
    content.push({
      type: "input_image",
      image_url: `data:${image.contentType};base64,${image.buffer.toString("base64")}`,
      detail: "high",
    });
  }

  let response;
  try {
    response = await fetch(OPENAI_RESPONSES_URL, {
      method: "POST",
      headers: {
        Authorization: `Bearer ${getApiKey()}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify({
        model: process.env.OPENAI_MODEL || DEFAULT_MODEL,
        input: [{ role: "user", content }],
        text: {
          format: {
            type: "json_schema",
            name: "math_explanation",
            strict: true,
            schema: mathExplanationSchema,
          },
        },
      }),
    });
  } catch (error) {
    throw Object.assign(new Error(`OpenAI request failed: ${error.message}`), {
      statusCode: 502,
      code: "AI_SERVICE_UNAVAILABLE",
      publicMessage: "The AI service is temporarily unreachable.",
    });
  }

  const responseText = await response.text();
  let responseBody;
  try {
    responseBody = responseText ? JSON.parse(responseText) : {};
  } catch {
    responseBody = { error: { message: responseText } };
  }

  if (!response.ok) {
    const message = responseBody.error?.message || `OpenAI request failed with status ${response.status}`;
    throw Object.assign(new Error(message), {
      statusCode: response.status === 429 ? 429 : 502,
      code: response.status === 429 ? "AI_PROVIDER_RATE_LIMITED" : "AI_SERVICE_ERROR",
      publicMessage: response.status === 429
        ? "The AI service is busy or rate limited. Please try again later."
        : "The AI service could not complete the request.",
    });
  }

  return parseExplanation(responseBody);
}
