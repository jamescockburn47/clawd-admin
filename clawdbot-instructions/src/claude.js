import Anthropic from '@anthropic-ai/sdk';
import config from './config.js';
import { getSystemPrompt } from './prompt.js';

const client = new Anthropic({ apiKey: config.anthropicApiKey });

let dailyCalls = 0;
let dailyResetDate = new Date().toDateString();

function checkDailyLimit() {
  const today = new Date().toDateString();
  if (today !== dailyResetDate) {
    dailyCalls = 0;
    dailyResetDate = today;
  }
  return dailyCalls < config.dailyCallLimit;
}

const ERROR_MESSAGES = {
  429: "Mon Dieu, I have been speaking too much. Even I need to rest my voice.",
  529: "The muse is overwhelmed. Even genius has its limits.",
};

export async function getMonetResponse(context, mode) {
  if (!checkDailyLimit()) {
    console.log(`[claude] Daily limit reached (${config.dailyCallLimit}). Ignoring.`);
    return null;
  }

  try {
    dailyCalls++;
    const response = await client.messages.create({
      model: config.claudeModel,
      max_tokens: config.maxResponseTokens,
      system: getSystemPrompt(mode),
      messages: [{ role: 'user', content: context }],
    });

    const text = response.content?.[0]?.text;
    if (!text) return null;

    console.log(`[claude] Tokens — input: ${response.usage?.input_tokens}, output: ${response.usage?.output_tokens} | Calls today: ${dailyCalls}/${config.dailyCallLimit}`);
    return text;
  } catch (err) {
    const status = err?.status;
    if (ERROR_MESSAGES[status]) {
      console.error(`[claude] API error ${status}: ${err.message}`);
      return ERROR_MESSAGES[status];
    }
    console.error(`[claude] API error: ${err.message}`);
    return null;
  }
}
