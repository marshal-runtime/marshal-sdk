/** Quoted data cannot create structural prompt tags. Original files and tool results are unchanged. */
export const inert = (text: string): string => text.replace(/</g, "\u2039").replace(/>/g, "\u203a");

/** One line: control characters and line or paragraph separators become a space, so a stored name cannot add lines to text sent to a person. */
export const lineLabel = (text: string): string => text.replace(/[\u0000-\u001f\u007f-\u009f\u2028\u2029]+/g, " ");

export const promptLabel = (text: string): string => inert(lineLabel(text));
