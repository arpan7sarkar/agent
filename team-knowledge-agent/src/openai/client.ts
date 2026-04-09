import OpenAI from "openai";
import { getEnv } from "../config/env.js";

const env = getEnv();

let cachedClient: OpenAI | null = null;

export function getOpenAIClient(): OpenAI {
  if (cachedClient) return cachedClient;

  cachedClient = new OpenAI({
    apiKey: env.OPENAI_API_KEY,
  });

  return cachedClient;
}

export type GenerateTextResult = {
  text: string;
  requestId?: string;
};

export async function generateText(
  instructions: string,
  input: string,
): Promise<GenerateTextResult> {
  const client = getOpenAIClient();
  const response = await client.responses.create({
    model: env.OPENAI_MODEL,
    instructions,
    input,
  });

  const result: GenerateTextResult = {
    text: response.output_text ?? "",
  };
  if (response._request_id) {
    result.requestId = response._request_id;
  }
  return result;
}
