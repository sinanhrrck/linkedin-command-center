import { GoogleGenerativeAI } from "@google/generative-ai";
import { config } from "../config.js";

const genAI = new GoogleGenerativeAI(config.gemini.apiKey);
const model = genAI.getGenerativeModel({ model: config.gemini.model });

/** Ein einfacher Prompt → Text. Nutzt den kostenlosen Gemini-Tier. */
export async function generate(prompt: string): Promise<string> {
  const res = await model.generateContent(prompt);
  return res.response.text().trim();
}
