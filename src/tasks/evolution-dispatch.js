// Task: Pick up pending evolution tasks

import { getNextPending, updateTask, canRunTask, formatApprovalMessage } from '../evolution.js';
import { executeEvolutionTask } from '../evolution-executor.js';
import config from '../config.js';
import logger from '../logger.js';

/**
 * Check for and execute pending evolution tasks.
 *
 * Note: forge-sourced tasks are created with pre_implemented=true and go
 * directly to 'awaiting_approval'. They bypass this dispatcher entirely —
 * the forge has already run architect/implement/review and the branch exists.
 * Only non-forge tasks (WhatsApp evolution_task, overnight-to-evolution) hit
 * the executor path below.
 *
 * @param {Function} sendFn - WhatsApp send function
 */
export async function checkEvolutionTasks(sendFn) {
  const task = getNextPending();
  if (!task) return;

  // Defence in depth: if a pre-implemented task somehow appears as 'pending',
  // promote it without running the executor (its branch already exists).
  if (task.pre_implemented) {
    updateTask(task.id, { status: 'awaiting_approval' });
    logger.info({ taskId: task.id }, 'evolution: pre-implemented task promoted without execution');
    return;
  }

  const { allowed, reason } = canRunTask();
  if (!allowed) {
    logger.debug({ taskId: task.id, reason }, 'evolution: rate limited');
    return;
  }

  updateTask(task.id, { status: 'running' });
  logger.info({ taskId: task.id, instruction: task.instruction.slice(0, 100) }, 'evolution: executing task');

  try {
    const result = await executeEvolutionTask(task);
    const updatedTask = updateTask(task.id, {
      status: 'awaiting_approval',
      diff_summary: result.summary,
      diff_detail: result.diff,
      files_changed: result.files,
      branch: result.branch,
      manifest: result.manifest || null,
      total_lines: result.totalLines || null,
    });

    // Send approval DM to James (non-fatal -- task is already in branch)
    try {
      if (sendFn && config.ownerJid) {
        const msg = formatApprovalMessage(updatedTask || task);
        const sent = await sendFn(msg);
        if (sent?.key?.id) {
          updateTask(task.id, { approval_message_id: sent.key.id });
        }
      }
    } catch (dmErr) {
      logger.warn({ taskId: task.id, err: dmErr.message }, 'evolution: approval DM failed (task still awaiting approval)');
    }

    logger.info({ taskId: task.id, files: result.files }, 'evolution: awaiting approval');
  } catch (err) {
    updateTask(task.id, { status: 'failed', result: err.message });
    logger.error({ taskId: task.id, err: err.message }, 'evolution: task failed');

    // Notify James of failure (non-fatal)
    try {
      if (sendFn && config.ownerJid) {
        await sendFn(`Evolution task failed (${task.id}): ${err.message}`);
      }
    } catch (err2) { logger.warn({ err: err2.message }, 'evolution failure notification failed'); }
  }
}
