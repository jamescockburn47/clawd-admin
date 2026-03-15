#!/usr/bin/env node
// Comprehensive Ollama benchmark for Pi 5
// Tests all available models across different prompt types
// Usage: node bench.mjs

const OLLAMA_HOST = 'http://localhost:11434';
const MODELS = [
  'gemma3:1b',
  'qwen2.5:1.5b',
  'qwen3:1.7b',
  'gemma2:2b',
  'qwen3.5:4b',
];

const PROMPTS = [
  { name: 'greeting', text: 'Hello, how are you?', maxTokens: 50 },
  { name: 'short_chat', text: "That's hilarious, tell me more about your day", maxTokens: 80 },
  { name: 'opinion', text: "What do you think about pineapple on pizza? Keep it brief.", maxTokens: 100 },
  { name: 'longer_reply', text: "Tell me a very short joke and explain why it's funny in 2-3 sentences.", maxTokens: 150 },
  { name: 'personality', text: "You're a witty British assistant. Someone just sent you a photo of a cat wearing a hat. React in character.", maxTokens: 120 },
];

const SYSTEM_PROMPT = "You are Clawd, a witty and slightly sardonic WhatsApp assistant. Keep responses concise and conversational. No markdown.";

async function warmModel(model) {
  // Load model into memory by running a trivial prompt
  try {
    await fetch(`${OLLAMA_HOST}/api/chat`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        model,
        messages: [{ role: 'user', content: 'hi' }],
        think: false,
        stream: false,
        options: { num_predict: 1 },
      }),
      signal: AbortSignal.timeout(120000),
    });
  } catch {}
}

async function testModel(model, prompt, maxTokens) {
  const start = Date.now();
  try {
    const res = await fetch(`${OLLAMA_HOST}/api/chat`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        model,
        messages: [
          { role: 'system', content: SYSTEM_PROMPT },
          { role: 'user', content: prompt },
        ],
        think: false,
        stream: false,
        options: {
          num_predict: maxTokens,
          temperature: 0.7,
        },
      }),
      signal: AbortSignal.timeout(120000),
    });

    const elapsed = Date.now() - start;
    if (!res.ok) {
      return { error: `HTTP ${res.status}`, elapsed };
    }

    const data = await res.json();
    const content = data.message?.content || '';
    const thinking = data.message?.thinking || '';
    const evalCount = data.eval_count || 0;
    const evalDurationNs = data.eval_duration || 0;
    const promptEvalNs = data.prompt_eval_duration || 0;
    const loadNs = data.load_duration || 0;
    const totalNs = data.total_duration || 0;

    const tokPerSec = evalCount > 0 && evalDurationNs > 0
      ? (evalCount / (evalDurationNs / 1e9)).toFixed(1)
      : '0';

    return {
      content: content.slice(0, 200),
      contentLen: content.length,
      thinkingLen: thinking.length,
      evalTokens: evalCount,
      tokPerSec: parseFloat(tokPerSec),
      evalMs: Math.round(evalDurationNs / 1e6),
      promptEvalMs: Math.round(promptEvalNs / 1e6),
      loadMs: Math.round(loadNs / 1e6),
      totalMs: Math.round(totalNs / 1e6),
      wallMs: elapsed,
    };
  } catch (err) {
    return { error: err.message, elapsed: Date.now() - start };
  }
}

async function getModelSize(model) {
  try {
    const res = await fetch(`${OLLAMA_HOST}/api/show`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ model }),
    });
    const data = await res.json();
    const params = data.details?.parameter_size || 'unknown';
    const quant = data.details?.quantization_level || 'unknown';
    return `${params} (${quant})`;
  } catch {
    return 'unknown';
  }
}

async function main() {
  console.log('=== Ollama Pi 5 Benchmark ===');
  console.log(`Date: ${new Date().toISOString()}`);
  console.log(`Models: ${MODELS.length}, Prompts: ${PROMPTS.length}`);
  console.log('');

  // Check available RAM
  try {
    const { execSync } = await import('child_process');
    const memInfo = execSync('free -h').toString();
    console.log('Memory:');
    console.log(memInfo);
  } catch {}

  const results = {};

  for (const model of MODELS) {
    console.log(`\n${'='.repeat(60)}`);
    const size = await getModelSize(model);
    console.log(`MODEL: ${model} (${size})`);
    console.log('='.repeat(60));

    // Warm up - load model into memory
    console.log('  Warming up...');
    await warmModel(model);

    // Small delay for model to settle
    await new Promise(r => setTimeout(r, 2000));

    results[model] = { size, tests: [] };

    for (const prompt of PROMPTS) {
      console.log(`  Testing: ${prompt.name} (max ${prompt.maxTokens} tokens)...`);
      const result = await testModel(model, prompt.text, prompt.maxTokens);
      results[model].tests.push({ prompt: prompt.name, ...result });

      if (result.error) {
        console.log(`    ERROR: ${result.error} (${result.elapsed}ms)`);
      } else {
        console.log(`    ${result.tokPerSec} tok/s | ${result.evalTokens} tokens | eval ${result.evalMs}ms | total ${result.totalMs}ms | wall ${result.wallMs}ms`);
        console.log(`    Response: "${result.content.slice(0, 80)}${result.contentLen > 80 ? '...' : ''}"`);
        if (result.thinkingLen > 0) {
          console.log(`    ⚠ THINKING: ${result.thinkingLen} chars (tokens wasted on reasoning)`);
        }
      }

      // Brief pause between tests
      await new Promise(r => setTimeout(r, 1000));
    }
  }

  // Summary table
  console.log('\n\n' + '='.repeat(80));
  console.log('SUMMARY');
  console.log('='.repeat(80));
  console.log('');

  // Header
  const header = 'Model'.padEnd(18) + 'Size'.padEnd(18) + 'Avg tok/s'.padEnd(12) + 'Avg eval ms'.padEnd(14) + 'Avg wall ms'.padEnd(14) + 'Quality';
  console.log(header);
  console.log('-'.repeat(80));

  const summaries = [];

  for (const model of MODELS) {
    const data = results[model];
    const validTests = data.tests.filter(t => !t.error);
    if (validTests.length === 0) {
      console.log(`${model.padEnd(18)}${data.size.padEnd(18)}FAILED`);
      continue;
    }

    const avgTokPerSec = (validTests.reduce((a, t) => a + t.tokPerSec, 0) / validTests.length).toFixed(1);
    const avgEvalMs = Math.round(validTests.reduce((a, t) => a + t.evalMs, 0) / validTests.length);
    const avgWallMs = Math.round(validTests.reduce((a, t) => a + t.wallMs, 0) / validTests.length);
    const avgContentLen = Math.round(validTests.reduce((a, t) => a + t.contentLen, 0) / validTests.length);
    const thinkingTests = validTests.filter(t => t.thinkingLen > 0).length;

    const qualityNote = thinkingTests > 0 ? `⚠ thinking in ${thinkingTests}/${validTests.length}` : `${avgContentLen} avg chars`;

    console.log(
      `${model.padEnd(18)}${data.size.padEnd(18)}${String(avgTokPerSec).padEnd(12)}${String(avgEvalMs).padEnd(14)}${String(avgWallMs).padEnd(14)}${qualityNote}`
    );

    summaries.push({ model, size: data.size, avgTokPerSec: parseFloat(avgTokPerSec), avgEvalMs, avgWallMs, avgContentLen, thinkingTests, tests: validTests });
  }

  // Recommendation
  console.log('\n' + '='.repeat(80));
  console.log('RECOMMENDATION');
  console.log('='.repeat(80));

  // Filter out models with thinking issues, then sort by tok/s
  const clean = summaries.filter(s => s.thinkingTests === 0);
  const fastest = [...clean].sort((a, b) => b.avgTokPerSec - a.avgTokPerSec);
  const bestBalance = [...clean].sort((a, b) => {
    // Score: prioritize speed but penalize very short responses (bad quality)
    const speedScore = a.avgTokPerSec / Math.max(...clean.map(c => c.avgTokPerSec));
    const qualityScore = a.avgContentLen / Math.max(...clean.map(c => c.avgContentLen));
    const aScore = speedScore * 0.6 + qualityScore * 0.4;
    const bSpeedScore = b.avgTokPerSec / Math.max(...clean.map(c => c.avgTokPerSec));
    const bQualityScore = b.avgContentLen / Math.max(...clean.map(c => c.avgContentLen));
    const bScore = bSpeedScore * 0.6 + bQualityScore * 0.4;
    return bScore - aScore;
  });

  if (fastest.length > 0) {
    console.log(`\nFastest: ${fastest[0].model} at ${fastest[0].avgTokPerSec} tok/s`);
  }
  if (bestBalance.length > 0) {
    console.log(`Best balance: ${bestBalance[0].model} (speed + quality)`);
  }

  // Show all responses for quality comparison
  console.log('\n' + '='.repeat(80));
  console.log('RESPONSE QUALITY SAMPLES (personality test)');
  console.log('='.repeat(80));

  for (const model of MODELS) {
    const personalityTest = results[model].tests.find(t => t.prompt === 'personality');
    if (personalityTest && !personalityTest.error) {
      console.log(`\n[${model}]:`);
      console.log(`  "${personalityTest.content}"`);
    }
  }

  console.log('\nDone.');
}

main().catch(console.error);
