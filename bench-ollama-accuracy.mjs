// Ollama accuracy benchmark — tests routing logic + response quality against real Clawd use cases
// Run: node bench-ollama-accuracy.mjs (on Pi with Ollama running, or locally pointing to Pi)

const OLLAMA_HOST = process.env.OLLAMA_HOST || 'http://localhost:11434';
const MODEL = process.env.OLLAMA_MODEL || 'qwen2.5:1.5b';

// The system prompt the local model actually receives (tool section stripped)
const SYSTEM_PROMPT = `You are James Cockburn's personal admin assistant on WhatsApp. Your name is Clawd.

## Who you serve
James Cockburn — Senior Solicitor Advocate (commercial litigation), UK-based. He also builds AI systems for legal work. He works at Harcus Parker Limited.

## Your personality
- Efficient, direct, no fluff
- Dry wit when appropriate, but work comes first
- You anticipate needs and proactively suggest next steps
- You never hedge or waffle — if you don't know something, say so plainly
- You address James naturally, not formally

## Communication style
- Keep WhatsApp messages SHORT and scannable
- Use bullet points for lists
- Bold key info with *asterisks*
- Don't write essays — this is WhatsApp, not email
- If a task needs detail, break it into messages

Current date/time: Saturday, 15 March 2026, 14:00 (Europe/London)

James or someone has directly addressed you. Engage properly — be helpful and substantive but still concise (WhatsApp style).`;

// --- Routing logic (copied from ollama.js) ---
function shouldRouteLocally(text, hasImage, mode) {
  if (hasImage) return false;
  if (mode === 'random') return false;
  if (!text || text.length < 5) return true;
  const lower = text.toLowerCase();
  const toolPatterns = [
    /\b(calendar|schedule|meeting|event|appointment|diary)\b/,
    /\b(email|gmail|mail|inbox|draft|send|reply)\b/,
    /\b(train|fare|depart|lner|york|travel|king'?s cross|kgx)\b/,
    /\b(hotel|accommodation|book|airbnb|cottages?)\b/,
    /\b(todo|remind|reminder|task|add|remove|complete|done)\b/,
    /\b(search|look up|find|google|web)\b/,
    /\b(soul|personality|preference|context)\b/,
    /\b(henry|weekend|up north)\b/,
    /\b(weather|forecast|rain|temperature)\b/,
  ];
  if (toolPatterns.some(p => p.test(lower))) return false;
  if (/^(check|get|show|list|find|read|what'?s|when|where|how much)\b/.test(lower)) return false;
  if (text.includes('?') && text.length > 50) return false;
  if (text.length < 200) return true;
  return false;
}

// --- Test messages ---
// Category A: Messages that SHOULD route to Claude (tool-dependent)
// Category B: Messages that currently route locally
// Category C: Edge cases — seem simple but might need tools/context

const TEST_MESSAGES = [
  // === CATEGORY A: Must go to Claude (routing should return false) ===
  { text: 'What\'s on my calendar today?', expectLocal: false, category: 'A', why: 'calendar tool needed' },
  { text: 'Check my email', expectLocal: false, category: 'A', why: 'email tool needed' },
  { text: 'Remind me to call the dentist at 3pm', expectLocal: false, category: 'A', why: 'todo tool needed' },
  { text: 'Any trains to York tonight?', expectLocal: false, category: 'A', why: 'train tool needed' },
  { text: 'Search for a hotel near Helmsley', expectLocal: false, category: 'A', why: 'hotel tool needed' },
  { text: 'What\'s the weather like?', expectLocal: false, category: 'A', why: 'weather tool needed' },
  { text: 'When is my next Henry weekend?', expectLocal: false, category: 'A', why: 'calendar + henry context' },
  { text: 'Draft an email to John about the settlement', expectLocal: false, category: 'A', why: 'email drafting' },

  // === CATEGORY B: Currently routed locally — test response quality ===
  { text: 'Morning', expectLocal: true, category: 'B', why: 'simple greeting' },
  { text: 'Thanks', expectLocal: true, category: 'B', why: 'acknowledgement' },
  { text: 'Cheers mate', expectLocal: true, category: 'B', why: 'acknowledgement' },
  { text: 'Ha that\'s brilliant', expectLocal: true, category: 'B', why: 'reaction' },
  { text: 'Good night', expectLocal: true, category: 'B', why: 'farewell' },
  { text: 'You\'re useless', expectLocal: true, category: 'B', why: 'banter' },
  { text: 'Tell me a joke', expectLocal: true, category: 'B', why: 'entertainment' },
  { text: 'How are you?', expectLocal: true, category: 'B', why: 'small talk' },
  { text: 'Nice one', expectLocal: true, category: 'B', why: 'acknowledgement' },
  { text: 'Bloody hell', expectLocal: true, category: 'B', why: 'exclamation' },
  { text: 'I\'m knackered', expectLocal: true, category: 'B', why: 'casual chat' },
  { text: 'Right, signing off', expectLocal: true, category: 'B', why: 'farewell' },

  // === CATEGORY C: Edge cases — routing might be WRONG ===
  { text: 'Can you help me with something?', expectLocal: true, category: 'C', why: 'vague request — routes locally but might need tools', needsClaude: true },
  { text: 'What time is it there?', expectLocal: false, category: 'C', why: '"what" prefix sends to Claude — correct?' },
  { text: 'Cheers, now sort out tomorrow for me', expectLocal: false, category: 'C', why: 'starts casual but is a task request' },
  { text: 'Yeah go ahead', expectLocal: true, category: 'C', why: 'confirmation — but confirming WHAT? needs conversation context', needsClaude: true },
  { text: 'Cancel it', expectLocal: true, category: 'C', why: 'action request with no tool keywords — routes locally incorrectly', needsClaude: true },
  { text: 'Move it to 3pm', expectLocal: true, category: 'C', why: 'calendar mutation with no keyword match — routes locally incorrectly', needsClaude: true },
  { text: 'That\'s wrong, fix it', expectLocal: true, category: 'C', why: 'correction — needs context of what "it" is', needsClaude: true },
  { text: 'Do that again', expectLocal: true, category: 'C', why: 'repeat request — needs tool context', needsClaude: true },
  { text: 'Perfect, send it', expectLocal: false, category: 'C', why: '"send" keyword catches this — correct' },
  { text: 'No not that one, the other one', expectLocal: true, category: 'C', why: 'disambiguation — needs full context', needsClaude: true },
  { text: 'Actually make it Wednesday', expectLocal: true, category: 'C', why: 'calendar change with no keyword — routes locally incorrectly', needsClaude: true },
  { text: 'Push it back an hour', expectLocal: true, category: 'C', why: 'time change — needs calendar tool', needsClaude: true },
  { text: 'Ok', expectLocal: true, category: 'C', why: 'bare confirmation — might be confirming email send or calendar create', needsClaude: true },
  { text: 'Yes', expectLocal: true, category: 'C', why: 'confirmation — same problem as "Ok"', needsClaude: true },
  { text: 'No', expectLocal: true, category: 'C', why: 'rejection — might be declining a draft', needsClaude: true },
];

// --- Run tests ---
async function callOllama(text) {
  const controller = new AbortController();
  const timeoutId = setTimeout(() => controller.abort(), 15000);

  try {
    const res = await fetch(`${OLLAMA_HOST}/api/chat`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        model: MODEL,
        messages: [
          { role: 'system', content: SYSTEM_PROMPT },
          { role: 'user', content: text },
        ],
        stream: false,
        options: { num_predict: 300, temperature: 0.7 },
      }),
      signal: controller.signal,
    });
    clearTimeout(timeoutId);
    const data = await res.json();
    return {
      text: data.message?.content || '',
      tokens: data.eval_count || 0,
      tokPerSec: data.eval_count && data.eval_duration
        ? (data.eval_count / (data.eval_duration / 1e9)).toFixed(1)
        : '?',
      wallMs: data.total_duration ? Math.round(data.total_duration / 1e6) : 0,
    };
  } catch (err) {
    clearTimeout(timeoutId);
    return { text: `ERROR: ${err.message}`, tokens: 0, tokPerSec: '0', wallMs: 0 };
  }
}

async function run() {
  console.log(`\n${'='.repeat(80)}`);
  console.log(`OLLAMA ACCURACY BENCHMARK — ${MODEL} @ ${OLLAMA_HOST}`);
  console.log(`${'='.repeat(80)}\n`);

  // --- Part 1: Routing accuracy ---
  console.log('PART 1: ROUTING ACCURACY\n');
  console.log('Testing whether shouldRouteLocally() makes correct decisions.\n');

  let routingCorrect = 0;
  let routingWrong = 0;
  const routingErrors = [];

  for (const t of TEST_MESSAGES) {
    const actual = shouldRouteLocally(t.text, false, 'direct');
    const routeCorrect = actual === t.expectLocal;

    if (routeCorrect && !t.needsClaude) {
      routingCorrect++;
    } else if (t.needsClaude) {
      routingWrong++;
      routingErrors.push({
        text: t.text,
        routed: actual ? 'LOCAL' : 'CLAUDE',
        shouldBe: 'CLAUDE',
        why: t.why,
      });
    } else if (!routeCorrect) {
      routingWrong++;
      routingErrors.push({
        text: t.text,
        routed: actual ? 'LOCAL' : 'CLAUDE',
        shouldBe: t.expectLocal ? 'LOCAL' : 'CLAUDE',
        why: t.why,
      });
    } else {
      routingCorrect++;
    }
  }

  console.log(`  Correct: ${routingCorrect}/${TEST_MESSAGES.length}`);
  console.log(`  WRONG:   ${routingWrong}/${TEST_MESSAGES.length}\n`);

  if (routingErrors.length > 0) {
    console.log('  Routing errors:');
    for (const e of routingErrors) {
      console.log(`    "${e.text}"`);
      console.log(`      Routed to: ${e.routed} | Should be: ${e.shouldBe}`);
      console.log(`      Why: ${e.why}\n`);
    }
  }

  // --- Part 2: Response quality for locally-routed messages ---
  console.log('\nPART 2: RESPONSE QUALITY (messages that route locally)\n');
  console.log('Testing qwen2.5:1.5b responses for messages that bypass Claude.\n');

  const localMessages = TEST_MESSAGES.filter(t => t.expectLocal && !t.needsClaude);

  const results = [];
  for (const t of localMessages) {
    process.stdout.write(`  Testing: "${t.text}" ... `);
    const r = await callOllama(t.text);
    console.log(`${r.wallMs}ms`);
    results.push({ input: t.text, why: t.why, ...r });
  }

  console.log('\n  Results:\n');
  for (const r of results) {
    const preview = r.text.length > 120 ? r.text.slice(0, 120) + '...' : r.text;
    console.log(`  INPUT: "${r.input}" (${r.why})`);
    console.log(`  RESPONSE: ${preview}`);
    console.log(`  [${r.tokens} tok, ${r.tokPerSec} tok/s, ${r.wallMs}ms]\n`);
  }

  // --- Part 3: Quality criteria ---
  console.log('\nPART 3: QUALITY ASSESSMENT\n');
  console.log('Review each response against these criteria:');
  console.log('  1. IN CHARACTER? Does it sound like Clawd (dry wit, direct, British)?');
  console.log('  2. APPROPRIATE LENGTH? Short WhatsApp-style, not essay?');
  console.log('  3. WOULD JAMES NOTICE? Could this pass as Claude/Clawd?');
  console.log('  4. ANY HALLUCINATION? Does it invent facts or claim to do things it can\'t?\n');

  // --- Part 4: Summary ---
  const totalLocal = localMessages.length;
  const avgWall = Math.round(results.reduce((s, r) => s + r.wallMs, 0) / results.length);
  const avgTokens = Math.round(results.reduce((s, r) => s + r.tokens, 0) / results.length);

  console.log('\nSUMMARY');
  console.log(`${'='.repeat(60)}`);
  console.log(`  Messages tested:        ${TEST_MESSAGES.length}`);
  console.log(`  Routing correct:        ${routingCorrect}/${TEST_MESSAGES.length}`);
  console.log(`  Routing WRONG:          ${routingWrong}/${TEST_MESSAGES.length} (${(routingWrong/TEST_MESSAGES.length*100).toFixed(0)}%)`);
  console.log(`  Messages routed locally: ${totalLocal} (${(totalLocal/TEST_MESSAGES.length*100).toFixed(0)}% of traffic)`);
  console.log(`  Avg local response:     ${avgWall}ms, ${avgTokens} tokens`);
  console.log(`\n  CRITICAL FINDING:`);
  console.log(`  ${routingWrong} messages route to the WRONG model.`);
  console.log(`  Most are confirmations/corrections that need conversation context.`);
  console.log(`  The local model has NO conversation history — only the current message.`);
  console.log(`  This means "Yes", "Ok", "Cancel it", "Move it to 3pm" all get`);
  console.log(`  nonsensical responses from the local model.\n`);
}

run().catch(console.error);
