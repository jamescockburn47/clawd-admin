import { getGroupConfig, getGroupLabel } from './group-registry.js';

// Dev-group JID is read lazily via `process.env` instead of the
// frozen `config` singleton. The existing group-tool-policy test boots
// without ANTHROPIC_API_KEY in the environment, which would reject the
// Zod config; reading env directly keeps the test's invariant.
function devGroupJid() {
  return (process.env.LQC_DEV_GROUP_JID || '').trim();
}

const SOVREN_LABELS = new Set(['sovren']);

const NON_PERSONAL_GROUP_TOOL_NAMES = new Set([
  'web_search',
  'web_fetch',
  'live_briefing',
  'memory_search',
  'memory_update',
  'memory_delete',
  'system_status',
  'project_list',
  'project_read',
  'project_pitch',
  'project_update',
  'project_list_files',
  'project_file_read',
  'overnight_status',
  'overnight_report',
  'send_file',
  'group_decisions',
  'group_status',
  'group_project',
  'group_block',
  'group_mode',
  'evolution_task',
  'sovren_site_access',
]);

/** LQ Council tool names — every tool name that starts with `lqc_` is
 *  gated to the dev group JID and owner DMs. Kept as a predicate rather
 *  than a set so new tools added later are automatically covered. */
function isLqcTool(name) {
  return typeof name === 'string' && name.startsWith('lqc_');
}

/** Strip LQC tools when the chat is not the configured dev group.
 *  Caller wraps in the existing SOVREN filter; this runs first so the
 *  restrictions compose. */
function stripLqcToolsForOtherChats(chatJid, tools) {
  const dev = devGroupJid();
  const isGroup = chatJid && chatJid.endsWith('@g.us');
  if (isGroup && dev && chatJid === dev) return tools;
  // Not a group (owner DM) — always allowed. The message processor
  // already restricts DM visibility to registered users.
  if (!isGroup) return tools;
  return tools.filter((tool) => !isLqcTool(tool.name));
}

export function filterToolsForChat(chatJid, tools) {
  // Strip LQC tools first (applies to any group that's not the dev JID).
  const base = stripLqcToolsForOtherChats(chatJid, tools);
  if (!chatJid || !chatJid.endsWith('@g.us')) return base;
  const groupLabel = (getGroupLabel(chatJid) || '').trim().toLowerCase();
  const groupConfig = getGroupConfig(chatJid);
  if (!SOVREN_LABELS.has(groupLabel) || !groupConfig?.allowedProjects?.includes('sovren')) {
    return base;
  }
  return base.filter((tool) => NON_PERSONAL_GROUP_TOOL_NAMES.has(tool.name));
}
