import { fileURLToPath } from 'url';
import { loadAgencyArtifacts, summariseAgencyOutcomes } from '../src/agency/analysis.js';

export function summariseAgencyDecisions(entries) {
  return summariseAgencyOutcomes({
    decisions: entries,
    interactions: [],
    feedback: [],
  });
}

const __filename = fileURLToPath(import.meta.url);

if (process.argv[1] && process.argv[1].replace(/\\/g, '/') === __filename.replace(/\\/g, '/')) {
  const summary = summariseAgencyOutcomes(loadAgencyArtifacts());
  console.log(JSON.stringify(summary, null, 2));
}
