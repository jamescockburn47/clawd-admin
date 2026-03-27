// Task: Check due todos and send WhatsApp reminders

import { getDueReminders, markReminded } from '../tools/todo.js';
import logger from '../logger.js';

/**
 * Check for due todo reminders and send WhatsApp messages.
 * @param {Function} sendFn - WhatsApp send function
 */
export async function checkTodoReminders(sendFn) {
  if (!sendFn) return;
  const due = getDueReminders();
  for (const todo of due) {
    const msg = `*Reminder:* ${todo.text}${todo.dueDate ? '\nDue: ' + todo.dueDate : ''}`;
    try {
      await sendFn(msg);
      markReminded(todo.id);
      logger.info({ todo: todo.text }, 'reminder sent');
    } catch (err) {
      logger.error({ todo: todo.text, err: err.message }, 'reminder send failed');
    }
  }
}
