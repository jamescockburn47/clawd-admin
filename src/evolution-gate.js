// src/evolution-gate.js — Evolution task creation confirmation and deploy approval
// Handles "confirm evolution <id>" and approve/reject flows via owner DM.

import logger from './logger.js';
import { getAwaitingApproval, updateTask } from './evolution.js';
import { deployApprovedTask, rejectTask } from './evolution-executor.js';

/**
 * Handle "confirm evolution <id>" — creation confirmation in owner DM.
 * Returns true if handled, false if not an evolution confirmation.
 */
export async function handleEvolutionConfirmation(sock, chatJid, text) {
  const evoConfirmMatch = text.match(/^confirm\s+evolution\s+([a-f0-9]+)/i);
  if (!evoConfirmMatch) return false;

  const { confirmEvolutionTask } = await import('./tools/handler.js');
  const task = confirmEvolutionTask(evoConfirmMatch[1]);
  if (task) {
    const { getTaskSummary } = await import('./evolution.js');
    const summary = getTaskSummary();
    await sock.sendMessage(chatJid, {
      text: `Evolution task queued (${task.id}): ${task.instruction}\n\nQueue: ${summary.pending} pending, ${summary.today}/3 today. I'll work on it and send the diff for approval.`,
    });
  } else {
    await sock.sendMessage(chatJid, { text: 'Confirmation expired or invalid. Ask Clawd to create the task again.' });
  }
  return true;
}

/**
 * Handle approve/reject of a pending evolution deploy.
 * Returns true if handled, false if no awaiting tasks or not an approval/rejection.
 */
export async function handleEvolutionApproval(sock, chatJid, text) {
  const lower = text.toLowerCase().trim();
  const isApproval = /^(approve|yes|deploy|merge|go ahead|do it|ship it)\b/i.test(lower);
  const isRejection = /^(reject|no|discard|cancel|don't|nope)\b/i.test(lower);

  if (!isApproval && !isRejection) return false;

  const awaitingTasks = getAwaitingApproval();
  if (awaitingTasks.length === 0) return false;

  // Take the most recent awaiting task
  const task = awaitingTasks[awaitingTasks.length - 1];

  if (isApproval) {
    updateTask(task.id, { status: 'approved' });
    try {
      await sock.sendMessage(chatJid, { text: `Deploying ${task.id}...` });
      const result = await deployApprovedTask(task);
      updateTask(task.id, { status: 'deployed', result: `Deployed ${result.files.length} file(s)` });
      await sock.sendMessage(chatJid, { text: `Deployed. ${result.files.length} file(s) updated. Service healthy.` });
    } catch (err) {
      updateTask(task.id, { status: 'failed', result: err.message });
      await sock.sendMessage(chatJid, { text: `Deploy failed: ${err.message}` });
    }
  } else {
    await rejectTask(task);
    updateTask(task.id, { status: 'rejected', result: `Rejected by James: ${text}` });
    await sock.sendMessage(chatJid, { text: `Rejected and discarded (${task.id}).` });
  }
  return true;
}
