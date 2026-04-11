/**
 * Assembles role-specific prompt context from already-retrieved strings.
 * No retrieval or network calls — callers pass transcript and optional blobs.
 */
export function buildContextPack(input: {
  role: string;
  transcript: string;
  relevantMemoryText: string | null;
  prefetchedWebText: string | null;
}): string {
  const parts = [`## Recent conversation\n${input.transcript}`];
  if (input.role === 'memory_recall' && input.relevantMemoryText) {
    parts.push(`## Relevant memory\n${input.relevantMemoryText}`);
  }
  if (input.role === 'research_injection' && input.prefetchedWebText) {
    parts.push(`## Current research\n${input.prefetchedWebText}`);
  }
  return parts.join('\n\n');
}
