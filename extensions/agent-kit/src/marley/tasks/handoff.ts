// Extract of zygstinct apps/agent-server/src/tasks/handoff.ts at 7110e58c8: only HandoffChat.
/**
 * What a task keeps of the conversation that started it, so the worker works from the person's own words and not only the front's brief:
 * the messages the originating turn answered (verbatim, bounded) and the last few chat lines before them. It is read only from that one
 * conversation (a direct chat gives that chat's lines, a group gives that group's), never from another chat, memory or a private note,
 * and it is data: the worker prompt escapes it and labels it context (PI01, PM01/PM02).
 */
export interface HandoffChat {
  said: string[];
  recent: { from: string; text: string }[];
}
