// Reference skill — demonstrates the contract for forge-authored skills.
// canHandle always returns false; this skill never triggers in production.

const skill = {
  name: 'example-skill',
  description: 'Reference implementation showing the skill contract. Never triggers.',
  version: '1.0.0',
  created: '2026-04-03',
  author: 'forge',

  // Array of trigger descriptions (human-readable, for describeCapabilities)
  triggers: ['Never — this is a reference implementation only'],

  // Gate: return true if this skill should handle the message
  canHandle(msg, context) {
    return false;
  },

  // Execute: receives msg + context (including .response from post-processing).
  // Return a string to replace the response, or falsy to keep the original.
  execute(msg, context) {
    return null;
  },

  // Natural-language self-explanation for Clawd's self-awareness
  selfExplanation: 'I have an example skill installed that demonstrates the skill contract. It never activates.',

  // Usage examples for documentation / overnight analysis
  examples: [
    { input: 'anything', output: 'no match — canHandle always returns false' },
  ],

  // Runtime metrics — mutated by the registry
  metrics: {
    timesTriggered: 0,
    lastTriggered: null,
  },
};

export default skill;
