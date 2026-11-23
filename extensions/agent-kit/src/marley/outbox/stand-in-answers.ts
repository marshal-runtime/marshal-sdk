/**
 * What a stand-in model answers to the outbox's own structured runs, shared by the simulator's stub model and the local stack's scripted model (which
 * may not import from src/simulator). Every reply goes through the outbox, so a stand-in that leaves these unanswered sends nothing at all.
 */

/**
 * A composer run (a structured answer under the compose schema): pass every piece of material on as one message, voice when every piece is a voice
 * note, else text, naming all of them as used. It reads the material block of the composer prompt (outbox/composer.ts), so a run shows what the turn
 * wrote, as the unit tests' pass-through composer does (R102.3: every word reaches the person through a composed moment).
 */
export function stubComposerAnswer(prompt: string): Record<string, unknown> {
  const block = /<material>\n([\s\S]*?)\n<\/material>/.exec(prompt)?.[1];
  const pieces: { id: string; kind: string; text: string }[] = [];
  for (const line of block && block !== "(none)" ? block.split("\n") : []) {
    const head = /^- \[([^\]]+)\] from .*? \((text|voice)\): (.*)$/.exec(line);
    if (head) pieces.push({ id: head[1]!, kind: head[2]!, text: head[3]! });
    else if (pieces.length > 0) pieces[pieces.length - 1]!.text += `\n${line}`;
  }
  if (pieces.length === 0) return { action: "nothing", reason: "no material" };
  const words = pieces.map((piece) => piece.text).join("\n\n");
  const body = pieces.every((piece) => piece.kind === "voice") ? { voice: words } : { text: words };
  return { action: "send", ...body, used_material: pieces.map((piece) => piece.id), reason: "stub pass-through" };
}

/**
 * An outbox screen run (outbox/screen.ts, a structured answer under the screen schema): judge every text clean, one verdict per `<text id>` block, so a
 * composed moment is sent as the composer wrote it. Without it every stubbed reply would be held back as unjudged (the screen's failure path).
 */
export function stubScreenAnswer(prompt: string): Record<string, unknown> {
  return { verdicts: [...prompt.matchAll(/<text id="(t\d+)">/g)].map((match) => ({ id: match[1]!, system_talk: false })) };
}
