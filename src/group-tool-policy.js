import { getGroupConfig, getGroupLabel } from './group-registry.js';

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

export function filterToolsForChat(chatJid, tools) {
  if (!chatJid || !chatJid.endsWith('@g.us')) return tools;
  const groupLabel = (getGroupLabel(chatJid) || '').trim().toLowerCase();
  const groupConfig = getGroupConfig(chatJid);
  if (!SOVREN_LABELS.has(groupLabel) || !groupConfig?.allowedProjects?.includes('sovren')) {
    return tools;
  }
  return tools.filter((tool) => NON_PERSONAL_GROUP_TOOL_NAMES.has(tool.name));
}
