/// <reference types="node" />
import type { MethodologyContribution } from './types.js';

/**
 * Pure renderer for the human-readable companion to a methodology JSON. Kept
 * in its own file so the contribution store can use it without pulling in the
 * methodology extractor (which depends on EVO config).
 */
export function renderMethodologyMarkdown(m: MethodologyContribution): string {
  const lines: string[] = [];
  lines.push(`# ${m.contributor} contribution — ${m.receivedAt.slice(0, 10)}`);
  lines.push('');
  lines.push(`**Kind:** ${m.sourceKind}`);
  if (m.sourceFiles.length > 0) {
    lines.push(`**Source files:** ${m.sourceFiles.map((f) => f.fileName).join(', ')}`);
  }
  lines.push('');
  lines.push(`> ${m.shortDescription}`);
  lines.push('');

  if (m.variables.length > 0) {
    lines.push('## Variables');
    for (const v of m.variables) {
      lines.push(`- **${v.name}** (${v.domain}) — ${v.definition}`);
      if (v.sourceCells.length > 0) lines.push(`  - source: ${v.sourceCells.join(', ')}`);
    }
    lines.push('');
  }

  if (m.formulas.length > 0) {
    lines.push('## Formulas');
    for (const f of m.formulas) {
      lines.push(`- **${f.label}** at \`${f.sourceCell}\``);
      lines.push(`  - \`${f.symbolic}\``);
      if (f.dependsOn.length > 0) lines.push(`  - depends on: ${f.dependsOn.join(', ')}`);
      if (f.appearsInExamples.length > 0) lines.push(`  - examples: ${f.appearsInExamples.join(', ')}`);
    }
    lines.push('');
  }

  if (m.anchors.length > 0) {
    lines.push('## Anchors');
    for (const a of m.anchors) {
      lines.push(`- **${a.reference}** — ${a.meaning} (${a.cells.join(', ')})`);
    }
    lines.push('');
  }

  if (m.workedExamples.length > 0) {
    lines.push('## Worked examples');
    for (const w of m.workedExamples) {
      lines.push(`- **${w.name}** / ${w.stage}: output = ${w.output}`);
    }
    lines.push('');
  }

  if (m.openQuestions.length > 0) {
    lines.push('## Open questions');
    for (const q of m.openQuestions) lines.push(`- ${q}`);
    lines.push('');
  }

  if (m.conflicts.length > 0) {
    lines.push('## Conflicts with existing methodology');
    for (const c of m.conflicts) {
      lines.push(`- **${c.with}** (${c.severity}): ${c.description}`);
    }
    lines.push('');
  }

  if (m.suggestedLinks.length > 0) {
    lines.push('## Suggested links into SOVREN code');
    for (const l of m.suggestedLinks) lines.push(`- \`${l}\``);
    lines.push('');
  }

  return lines.join('\n');
}
