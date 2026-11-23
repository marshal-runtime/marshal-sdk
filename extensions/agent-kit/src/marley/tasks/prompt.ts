// Extract of zygstinct apps/agent-server/src/tasks/prompt.ts at 7110e58c8: only taskIdOfEvent.
/**
 * The id of a result event the replaced relay path stored (`task:<task id>:<status>`, a follow-up's with `:f<n>`), or null: read only to recognise such
 * stored rows (the outbox's older material), never written any more.
 */
export const taskIdOfEvent = (messageId: string): string | null => {
  const match = /^task:(tsk_[0-9A-HJKMNP-TV-Z]{26}):(done|failed)(?::f\d{1,4})?$/.exec(messageId);
  return match ? match[1]! : null;
};
