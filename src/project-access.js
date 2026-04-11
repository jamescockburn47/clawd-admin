import { getGroupConfig } from './group-registry.js';
import { getProjectById } from './tools/projects.js';
import logger from './logger.js';

const DEFAULT_OFFTOPIC_POLICY = 'allow';
const MAX_SUMMARY_CHARS = 1400;

function normalizeText(value) {
  return (value || '').toLowerCase();
}

function extractCurrentMessage(contextText) {
  const marker = '[Current message]\n';
  const idx = contextText.lastIndexOf(marker);
  if (idx === -1) return contextText || '';
  return contextText.slice(idx + marker.length).trim();
}

function truncate(value, maxChars) {
  if (!value) return '';
  if (value.length <= maxChars) return value;
  return `${value.slice(0, maxChars)}...`;
}

function buildKeywordSet(project) {
  const words = new Set();
  words.add(normalizeText(project.id));
  if (project.name) {
    for (const part of String(project.name).split(/\W+/)) {
      if (part.length >= 4) words.add(normalizeText(part));
    }
  }
  if (Array.isArray(project.tags)) {
    for (const tag of project.tags) {
      if (typeof tag === 'string' && tag.trim().length >= 4) {
        words.add(normalizeText(tag));
      }
    }
  }
  return [...words].filter(Boolean);
}

function isLikelyProjectMessage(messageText, project) {
  const normalized = normalizeText(messageText);
  const keywords = buildKeywordSet(project);
  return keywords.some((kw) => normalized.includes(kw));
}

function buildProjectKnowledge(project) {
  const lines = [];
  lines.push(`Project: ${project.name || project.id}`);
  if (project.status) lines.push(`Status: ${project.status}`);
  if (project.oneLiner) lines.push(`One-liner: ${project.oneLiner}`);
  if (project.summary) lines.push(`Summary: ${truncate(project.summary, MAX_SUMMARY_CHARS)}`);
  if (project.evoPath) lines.push(`EVO path: ${project.evoPath}`);
  if (Array.isArray(project.tags) && project.tags.length > 0) {
    lines.push(`Tags: ${project.tags.join(', ')}`);
  }
  return lines.join('\n');
}

/**
 * Builds a prompt fragment for project-scoped groups.
 * Keeps logic lightweight and deterministic: no network calls and no extra retrieval pass.
 */
export function buildProjectScopePrompt(chatJid, contextText) {
  const groupConfig = getGroupConfig(chatJid);
  const allowedProjects = Array.isArray(groupConfig?.allowedProjects)
    ? groupConfig.allowedProjects.filter(Boolean)
    : [];

  if (allowedProjects.length === 0) return '';

  const primaryProjectId = allowedProjects[0];
  const primaryProject = getProjectById(primaryProjectId);
  if (!primaryProject) {
    logger.warn({ chatJid, projectId: primaryProjectId }, 'project scope configured but project was not found');
    return '';
  }

  const scopeMode = groupConfig?.projectScopeMode || 'allow_list';
  const offTopicPolicy = groupConfig?.offTopicPolicy || DEFAULT_OFFTOPIC_POLICY;
  const currentMessage = extractCurrentMessage(contextText);
  const likelyOnTopic = isLikelyProjectMessage(currentMessage, primaryProject);
  const onTopicLine = likelyOnTopic ? 'on_topic' : 'possibly_off_topic';

  let fragment = '\n\n## PROJECT ACCESS POLICY\n';
  fragment += `Allowed projects in this group: ${allowedProjects.join(', ')}.\n`;
  fragment += `Primary project for this group: ${primaryProject.id}.\n`;
  fragment += `Scope mode: ${scopeMode}.\n`;
  fragment += `Off-topic policy: ${offTopicPolicy}.\n`;

  if (scopeMode === 'single_project_only') {
    fragment += 'You may discuss ONLY the primary project in this group.\n';
    fragment += 'If asked about unrelated topics, use a short soft redirect back to the project.\n';
    fragment += 'Do not provide substantive non-project analysis in this group.\n';
  } else {
    fragment += 'Prioritise allowed project context over general memories when answering.\n';
  }

  fragment += `Message scope heuristic: ${onTopicLine}.\n`;
  fragment += 'If heuristic says possibly_off_topic, keep response brief and steer back to the project.\n';
  fragment += '\n## PRIMARY PROJECT KNOWLEDGE\n';
  fragment += `${buildProjectKnowledge(primaryProject)}\n`;

  return fragment;
}
