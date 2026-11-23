/**
 * The memes the composer may make: well-known meme photos, each with the boxes its lines go into. A box is a fraction of the meme's canvas (x, y, w, h), a
 * style (`outline` is the classic white capitals with a black edge over the photo, `plain` dark words on a light area: a sign, a card, a white panel), an
 * angle in degrees (clockwise) for words that follow a tilted surface, and `max`, the longest line a small box still letters readably. `lines` says what
 * each box holds, in order: it is what the composer is told, so it writes one line per box.
 *
 * Most photos ship on the brand image (`file`, from packages/experience/memes, installed at MEME_PICTURES; the memegen template set, downscaled to at
 * most 900 px) and their boxes are tuned to that exact picture. A template with only a `url` is fetched from imgflip on the sandbox. Only a template's id
 * and its picture URL ever leave Marley: the words are drawn on the brand's own sandbox (meme-render.ts), so an owner's figures in a caption never reach
 * imgflip.
 */
export interface MemeBox { x: number; y: number; w: number; h: number; style: "outline" | "plain"; angle?: number; max?: number }
export interface MemeTemplate {
  id: string;
  name: string;
  /** The bundled photo's file name under MEME_PICTURES; a template without one is fetched from `url`. */
  file?: string;
  url?: string;
  /** The Drake layout: the photo fills the left half of a canvas twice its width, and the lines sit in the white right half. */
  panelRight?: boolean;
  /** When the joke fits, for the composer. */
  use: string;
  /** What each line is, in box order. */
  lines: string[];
  boxes: MemeBox[];
}

/** Where the brand image installs the bundled photos (image/experience-artifact.mjs copies packages/experience/memes there). */
export const MEME_PICTURES = "/opt/zygstinct/experience/memes";

const top = (style: MemeBox["style"] = "outline"): MemeBox => ({ x: 0.02, y: 0.01, w: 0.96, h: 0.22, style });
const bottom = (style: MemeBox["style"] = "outline"): MemeBox => ({ x: 0.02, y: 0.77, w: 0.96, h: 0.22, style });

export const MEME_TEMPLATES: readonly MemeTemplate[] = [
  { id: "drake", name: "Drake Hotline Bling", file: "drake.jpg", panelRight: true, use: "preferring one option over another", lines: ["the thing rejected", "the thing preferred"],
    boxes: [{ x: 0.52, y: 0.02, w: 0.46, h: 0.46, style: "plain" }, { x: 0.52, y: 0.52, w: 0.46, h: 0.46, style: "plain" }] },
  { id: "distracted-boyfriend", name: "Distracted Boyfriend", file: "db.jpg", use: "being tempted away from the current thing by a shiny new one", lines: ["the shiny new thing (woman in red)", "who is tempted (boyfriend)", "the current thing (girlfriend)"],
    boxes: [{ x: 0.1, y: 0.68, w: 0.34, h: 0.14, style: "outline", max: 65 }, { x: 0.5, y: 0.42, w: 0.24, h: 0.14, style: "outline", max: 45 }, { x: 0.73, y: 0.62, w: 0.25, h: 0.14, style: "outline", max: 45 }] },
  { id: "this-is-fine", name: "This Is Fine", file: "fine.jpg", use: "calm in the middle of chaos (light, never about a real loss)", lines: ["the chaos", "the calm reaction, such as \"this is fine\""],
    boxes: [top(), bottom()] },
  { id: "two-buttons", name: "Two Buttons", file: "ds.jpg", use: "a hard choice between two things", lines: ["left button", "right button", "who must choose"],
    boxes: [{ x: 0.08, y: 0.075, w: 0.34, h: 0.09, style: "plain", angle: 12.5, max: 60 }, { x: 0.45, y: 0.05, w: 0.27, h: 0.08, style: "plain", angle: 10.5, max: 50 }, { x: 0.04, y: 0.82, w: 0.92, h: 0.16, style: "outline" }] },
  { id: "change-my-mind", name: "Change My Mind", file: "cmm.jpg", use: "a confident take, said with a smile", lines: ["the take"],
    boxes: [{ x: 0.36, y: 0.46, w: 0.43, h: 0.18, style: "plain", angle: -17 }] },
  { id: "woman-yelling-at-cat", name: "Woman Yelling At Cat", file: "woman-cat.jpg", use: "an over-the-top complaint met with calm indifference", lines: ["the yelling", "the calm answer"],
    boxes: [{ x: 0.01, y: 0.01, w: 0.48, h: 0.19, style: "plain" }, { x: 0.51, y: 0.01, w: 0.48, h: 0.19, style: "plain" }] },
  { id: "uno-draw-25", name: "UNO Draw 25 Cards", url: "https://i.imgflip.com/3lmzyx.jpg", use: "someone would rather suffer than do one simple thing", lines: ["do this simple thing or draw 25", "who would rather draw 25"],
    boxes: [{ x: 0.16, y: 0.25, w: 0.27, h: 0.2, style: "plain" }, { x: 0.45, y: 0.62, w: 0.5, h: 0.18, style: "outline" }] },
  { id: "always-has-been", name: "Always Has Been", file: "astronaut.jpg", use: "a realisation that something was always true", lines: ["wait, it's all ...?", "always has been", "who just found out", "who always knew"],
    boxes: [{ x: 0.4, y: 0.3, w: 0.3, h: 0.16, style: "outline", max: 50 }, { x: 0.72, y: 0.04, w: 0.27, h: 0.16, style: "outline", max: 45 }, { x: 0.33, y: 0.78, w: 0.3, h: 0.14, style: "outline", max: 35 }, { x: 0.72, y: 0.7, w: 0.27, h: 0.14, style: "outline", max: 30 }] },
  { id: "expanding-brain", name: "Expanding Brain", file: "gb.jpg", use: "ideas getting (ironically) more enlightened, four steps", lines: ["step 1", "step 2", "step 3", "step 4 (most enlightened, really the worst)"],
    boxes: [{ x: 0.01, y: 0.005, w: 0.47, h: 0.235, style: "plain" }, { x: 0.01, y: 0.26, w: 0.47, h: 0.235, style: "plain" }, { x: 0.01, y: 0.515, w: 0.47, h: 0.215, style: "plain" }, { x: 0.01, y: 0.75, w: 0.47, h: 0.245, style: "plain" }] },
  { id: "trade-offer", name: "Trade Offer", url: "https://i.imgflip.com/54hjww.jpg", use: "a deal: what you give and what you get", lines: ["i receive", "you receive"],
    boxes: [{ x: 0.03, y: 0.28, w: 0.4, h: 0.16, style: "outline" }, { x: 0.57, y: 0.28, w: 0.4, h: 0.16, style: "outline" }] },
  { id: "roll-safe", name: "Roll Safe Think About It", file: "rollsafe.jpg", use: "a 'clever' loophole that is obviously silly", lines: ["the setup", "the clever loophole"],
    boxes: [top(), bottom()] },
  { id: "one-does-not-simply", name: "One Does Not Simply", file: "mordor.jpg", use: "something that is harder than it sounds", lines: ["one does not simply", "the hard thing"],
    boxes: [top(), bottom()] },
  { id: "hide-the-pain-harold", name: "Hide the Pain Harold", file: "harold.jpg", use: "smiling through a small, shared pain", lines: ["the situation", "the brave smile"],
    boxes: [top(), bottom()] },
  { id: "disaster-girl", name: "Disaster Girl", file: "disastergirl.jpg", use: "a cheeky 'I did this' about a small mischief", lines: ["the situation", "the cheeky culprit"],
    boxes: [top(), bottom()] },
  { id: "surprised-pikachu", name: "Surprised Pikachu", url: "https://i.imgflip.com/2kbn1e.jpg", use: "fake surprise at an obvious consequence", lines: ["what was done", "the obvious result", "the surprise"],
    boxes: [{ x: 0.03, y: 0.01, w: 0.94, h: 0.13, style: "plain" }, { x: 0.03, y: 0.14, w: 0.94, h: 0.13, style: "plain" }, { x: 0.03, y: 0.83, w: 0.94, h: 0.15, style: "outline" }] },
  { id: "epic-handshake", name: "Epic Handshake", file: "handshake.jpg", use: "two sides agreeing on one thing", lines: ["one side", "the other side", "what they agree on"],
    boxes: [{ x: 0.02, y: 0.45, w: 0.38, h: 0.16, style: "outline", angle: -45 }, { x: 0.6, y: 0.47, w: 0.38, h: 0.16, style: "outline", angle: 27.5 }, { x: 0.3, y: 0.08, w: 0.4, h: 0.18, style: "outline" }] },
  { id: "stonks", name: "Stonks", file: "stonks.jpg", use: "a questionable money move that looks like genius", lines: ["the questionable money move", "the verdict, such as \"stonks\""],
    boxes: [top(), bottom()] },
  { id: "is-this-a-pigeon", name: "Is This a Pigeon?", file: "pigeon.jpg", use: "confidently mistaking one thing for another", lines: ["who is confused (the man)", "what they see (the butterfly)", "their wrong guess, as \"is this ...?\""],
    boxes: [{ x: 0.12, y: 0.02, w: 0.4, h: 0.2, style: "outline" }, { x: 0.66, y: 0.26, w: 0.28, h: 0.16, style: "outline", max: 45 }, { x: 0.02, y: 0.78, w: 0.96, h: 0.2, style: "outline" }] },
  { id: "gru-plan", name: "Gru's Plan", file: "gru.jpg", use: "a plan whose flaw shows up only at the last step", lines: ["step one of the plan", "step two", "step three: the flaw", "step four: the same flaw, noticed"],
    boxes: [{ x: 0.27, y: 0.17, w: 0.21, h: 0.26, style: "plain", max: 75 }, { x: 0.775, y: 0.17, w: 0.21, h: 0.26, style: "plain", max: 75 }, { x: 0.275, y: 0.67, w: 0.21, h: 0.26, style: "plain", max: 75 }, { x: 0.775, y: 0.67, w: 0.21, h: 0.26, style: "plain", max: 75 }] },
  { id: "left-exit", name: "Left Exit 12 Off Ramp", file: "exit.jpg", use: "swerving away from the sensible option at the last moment", lines: ["the sensible road straight on", "the exit they swerve into", "who is driving"],
    boxes: [{ x: 0.23, y: 0.13, w: 0.17, h: 0.24, style: "outline", max: 25 }, { x: 0.52, y: 0.13, w: 0.24, h: 0.24, style: "outline" }, { x: 0.44, y: 0.86, w: 0.36, h: 0.12, style: "outline", angle: 9, max: 75 }] },
  { id: "success-kid", name: "Success Kid", file: "success.jpg", use: "a small win, celebrated", lines: ["the setup", "the small win"],
    boxes: [top(), bottom()] },
  { id: "panik-kalm-panik", name: "Panik Kalm Panik", file: "panik-kalm-panik.jpg", use: "panic, relief, then worse panic", lines: ["why to panic", "why it is fine after all", "why to panic again, worse"],
    boxes: [{ x: 0.01, y: 0.01, w: 0.45, h: 0.32, style: "plain" }, { x: 0.01, y: 0.35, w: 0.45, h: 0.32, style: "plain" }, { x: 0.01, y: 0.69, w: 0.45, h: 0.3, style: "plain" }] },
  { id: "x-everywhere", name: "X, X Everywhere", file: "buzz.jpg", use: "the same thing turning up everywhere", lines: ["the thing, such as \"discount codes\"", "the same thing, \"everywhere\""],
    boxes: [top(), bottom()] },
  { id: "spiderman-pointing", name: "Spider-Man Pointing at Spider-Man", file: "spiderman.jpg", use: "two sides that are really the same", lines: ["one side", "the other side, just the same"],
    boxes: [{ x: 0.03, y: 0.02, w: 0.45, h: 0.18, style: "outline" }, { x: 0.52, y: 0.02, w: 0.45, h: 0.18, style: "outline" }] },
];

export const MEME_IDS = MEME_TEMPLATES.map((template) => template.id) as [string, ...string[]];
export const memeTemplate = (id: string): MemeTemplate | undefined => MEME_TEMPLATES.find((template) => template.id === id);

/** A line as the composer's catalog names it: what the box holds and, for a small box, its limit. */
export const memeLineHint = (template: MemeTemplate, index: number): string => {
  const max = template.boxes[index]?.max;
  return max ? `${template.lines[index]} (at most ${max} characters)` : template.lines[index]!;
};
