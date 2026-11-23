import { MEME_PICTURES, memeTemplate, type MemeBox } from "./meme-templates.js";

/**
 * Draws a meme on the brand's sandbox, as the conversation's own chat user, into that chat's outbox (`files/outbox/`), where the outbox's image send reads it
 * (attachments.ts readHomeFile). The server sends the script on stdin and one base64 JSON argument built from the catalog: the picture and boxes come from
 * `MEME_TEMPLATES`, never from the model; the model gives only the template id and the words. The script reads the template's photo from the image
 * (MEME_PICTURES) or fetches a blank one (only from https://i.imgflip.com/), finds a bold font (a local one, else Anton from Google Fonts, cached), fits
 * each line into its box (turned by the box's angle) and writes a JPEG atomically.
 * It prints one JSON line: `{"ok":true,"path","bytes"}` or `{"ok":false,"why"}`.
 */
export const MEME_RENDER_SCRIPT = String.raw`import base64, io, json, os, sys, tempfile, unicodedata, urllib.request
def answer(value):
    sys.stdout.write(json.dumps(value)); sys.stdout.flush(); sys.exit(0)
try:
    from PIL import Image, ImageDraw, ImageFont
except Exception:
    answer({"ok": False, "why": "no_pillow"})
spec = json.loads(base64.b64decode(sys.argv[1]).decode("utf-8"))
home = os.path.expanduser("~")
cache = os.path.join(home, ".cache", "marley-memes")
os.makedirs(cache, exist_ok=True)
def fetch(url, limit):
    if not (url.startswith("https://i.imgflip.com/") or url.startswith("https://github.com/google/fonts/") or url.startswith("https://raw.githubusercontent.com/google/fonts/")):
        raise ValueError("url not allowed")
    with urllib.request.urlopen(urllib.request.Request(url, headers={"User-Agent": "marley-meme/1"}), timeout=15) as response:
        data = response.read(limit + 1)
    if len(data) > limit: raise ValueError("too large")
    return data
def cached(name, url, limit):
    target = os.path.join(cache, name)
    if not os.path.isfile(target) or os.path.islink(target):
        data = fetch(url, limit)
        fd, tmp = tempfile.mkstemp(dir=cache)
        with os.fdopen(fd, "wb") as handle: handle.write(data)
        os.replace(tmp, target)
    with open(target, "rb") as handle: return handle.read()
try:
    if spec.get("picture"):
        with open(spec["picture"], "rb") as handle: photo = Image.open(io.BytesIO(handle.read())).convert("RGB")
    else:
        photo = Image.open(io.BytesIO(cached(spec["template"] + os.path.splitext(spec["url"])[1], spec["url"], 6_000_000))).convert("RGB")
except Exception as error:
    answer({"ok": False, "why": "template_unavailable"})
# Drake: the photo is the left half of a white canvas, and the words sit in the right half.
if spec.get("panel_right"):
    picture = Image.new("RGB", (photo.width * 2, photo.height), "white"); picture.paste(photo, (0, 0))
else:
    picture = photo
def is_rtl(char):
    return unicodedata.bidirectional(char) in ("R", "AL")
# Emoji and other symbols are dropped from the words on the picture (no meme font draws them; they stay in the message's text).
given = [str(line) for line in spec["lines"]]
spec["lines"] = [" ".join("".join(char for char in str(line) if unicodedata.category(char) not in ("So", "Cs", "Co")).split()) for line in spec["lines"]]
rtl = any(is_rtl(char) for line in spec["lines"] for char in line)
CANDIDATES = ["/System/Library/Fonts/Supplemental/Impact.ttf", "/usr/share/fonts/truetype/msttcorefonts/Impact.ttf"]
try:
    import matplotlib
    CANDIDATES.append(os.path.join(matplotlib.get_data_path(), "fonts", "ttf", "DejaVuSans-Bold.ttf"))
except Exception:
    pass
CANDIDATES += ["/usr/share/fonts/truetype/dejavu/DejaVuSans-Bold.ttf", "/usr/share/fonts/dejavu/DejaVuSans-Bold.ttf", "/usr/share/fonts/truetype/liberation2/LiberationSans-Bold.ttf", "/usr/share/fonts/truetype/liberation/LiberationSans-Bold.ttf", "/System/Library/Fonts/Supplemental/Arial Bold.ttf", "/Library/Fonts/Arial Bold.ttf"]
def covers(path, chars):
    # A face covers the words when no letter draws as its missing-glyph box (compared with a code point no face has).
    try:
        face = ImageFont.truetype(path, 48)
        def glyph(char):
            canvas = Image.new("L", (96, 96)); ImageDraw.Draw(canvas).text((8, 8), char, font=face, fill=255); return canvas.tobytes()
        missing = glyph("\U0010FFFD")
        return all(glyph(char) != missing for char in chars)
    except Exception:
        return False
wanted = sorted({char for line in spec["lines"] for char in line if not char.isspace()})
present = [path for path in CANDIDATES if os.path.isfile(path)]
# A meme reads as a meme in Impact, or Anton (its open look-alike) when Impact is absent, as on the brand image; DejaVu and the rest only when neither
# draws the words (Hebrew), so a Latin meme on a sandbox no longer comes out in DejaVu.
font_path = next((path for path in present if "Impact" in path and covers(path, wanted)), None)
if font_path is None and not rtl:
    try:
        cached("Anton-Regular.ttf", "https://github.com/google/fonts/raw/main/ofl/anton/Anton-Regular.ttf", 2_000_000)
        if covers(os.path.join(cache, "Anton-Regular.ttf"), wanted): font_path = os.path.join(cache, "Anton-Regular.ttf")
    except Exception:
        pass
if font_path is None: font_path = next((path for path in present if covers(path, wanted)), None)
if font_path is None and not rtl:
    try:
        cached("Anton-Regular.ttf", "https://github.com/google/fonts/raw/main/ofl/anton/Anton-Regular.ttf", 2_000_000)
        if covers(os.path.join(cache, "Anton-Regular.ttf"), wanted): font_path = os.path.join(cache, "Anton-Regular.ttf")
    except Exception:
        pass
if font_path is None: answer({"ok": False, "why": "no_font"})
def font(size):
    if font_path: return ImageFont.truetype(font_path, size)
    try: return ImageFont.load_default(size=size)
    except TypeError: return ImageFont.load_default()
try:
    from PIL import features
    shaped = features.check("raqm")
except Exception:
    shaped = False
def visual(line):
    # Without libraqm Pillow draws characters left to right: a right-to-left line is put in visual order here (runs of right-to-left letters reversed,
    # the run order flipped), which is enough for a short meme line of words, digits and Latin names.
    if shaped or not any(is_rtl(char) for char in line): return line
    # Strong direction per character (digits count as left to right, so a figure is never reversed); a space or a mark between two left-to-right
    # characters stays with them, any other takes the line's right-to-left direction.
    strong = [True if unicodedata.bidirectional(c) in ("R", "AL") else False if unicodedata.bidirectional(c) in ("L", "EN", "AN") else None for c in line]
    kinds = []
    for index, kind in enumerate(strong):
        if kind is None:
            before = next((k for k in reversed(strong[:index]) if k is not None), True)
            after = next((k for k in strong[index + 1:] if k is not None), True)
            kind = before if before == after else True
        kinds.append(kind)
    runs, current, current_rtl = [], "", None
    for char, kind in zip(line, kinds):
        if current and kind != current_rtl: runs.append((current, current_rtl)); current = ""
        current += char; current_rtl = kind
    if current: runs.append((current, current_rtl))
    return "".join(text[::-1] if run_rtl else text for text, run_rtl in reversed(runs))
draw = ImageDraw.Draw(picture)
W, H = picture.size
def wrap(text, face, width):
    words, lines, current = [], [], ""
    # A currency or percent sign written apart ("300 ₪") stays on its number's line.
    for word in text.split():
        if words and all(unicodedata.category(char) == "Sc" or char == "%" for char in word): words[-1] += " " + word
        else: words.append(word)
    for word in words:
        trial = (current + " " + word).strip()
        if draw.textlength(trial, font=face) <= width or not current: current = trial
        else: lines.append(current); current = word
    if current: lines.append(current)
    return lines
# How each box's words came out: the size they were lettered at, how many lines they wrapped to, whether they fit the box at all (they are drawn anyway
# at the smallest size when they do not), and how much of the box's width and height they take. The preview answers with it; a send logs it.
fit = []
for index, (box, text) in enumerate(zip(spec["boxes"], spec["lines"])):
    text = " ".join(str(text).split())
    dropped = len("".join(given[index].split())) - len("".join(text.split())) if index < len(given) else 0
    if not text:
        fit.append({"box": index, "empty": True, "dropped": dropped}); continue
    if box["style"] == "outline": text = text.upper()
    bx, by, bw, bh = box["x"] * W, box["y"] * H, box["w"] * W, box["h"] * H
    size = max(12, int(bh * 0.5))
    while True:
        face = font(size)
        lines = wrap(text, face, bw)
        line_h = size * 1.12
        widest = max(draw.textlength(line, font=face) for line in lines)
        if (len(lines) * line_h <= bh and widest <= bw) or size <= 12: break
        size -= 2
    fit.append({"box": index, "size": size, "lines": len(lines), "fits": len(lines) * line_h <= bh and widest <= bw, "smallest": size <= 12, "width": round(widest / bw, 2), "height": round(len(lines) * line_h / bh, 2), "dropped": dropped})
    stroke = max(1, size // 12) if box["style"] == "outline" else 0
    # A tilted box (a sign, a button) is lettered flat on its own layer, turned clockwise by its angle and laid centred where the box is.
    angle = float(box.get("angle") or 0)
    pad = stroke + 2
    layer = Image.new("RGBA", (int(bw) + 2 * pad, int(bh) + 2 * pad), (0, 0, 0, 0)) if angle else None
    pen = ImageDraw.Draw(layer) if layer else draw
    ox, oy = (pad - bx, pad - by) if layer else (0, 0)
    y = by + (bh - len(lines) * line_h) / 2
    for line in lines:
        line = visual(line)
        x = bx + (bw - draw.textlength(line, font=face)) / 2
        if box["style"] == "outline":
            # The outline is drawn as offset copies, not Pillow's stroke_width, which clips a descender's outline (Hebrew ק read as ד on the sandbox).
            for dx in range(-stroke, stroke + 1):
                for dy in range(-stroke, stroke + 1):
                    if (dx or dy) and dx * dx + dy * dy <= stroke * stroke: pen.text((x + dx + ox, y + dy + oy), line, font=face, fill="black")
            pen.text((x + ox, y + oy), line, font=face, fill="white")
        else: pen.text((x + ox, y + oy), line, font=face, fill=(20, 20, 20))
        y += line_h
    if layer:
        turned = layer.rotate(-angle, resample=Image.BICUBIC, expand=True)
        picture.paste(turned, (int(bx + bw / 2 - turned.width / 2), int(by + bh / 2 - turned.height / 2)), turned)
face_name = os.path.basename(font_path)
# A preview is drawn in memory only: nothing is written under the chat's home (no outbox folder, no file the image send could pick up).
if spec.get("preview"):
    buffer = io.BytesIO(); picture.save(buffer, "JPEG", quality=88)
    answer({"ok": True, "preview": True, "bytes": len(buffer.getvalue()), "font": face_name, "fit": fit, "canvas": [W, H]})
outbox = os.path.join(home, "files", "outbox")
os.makedirs(outbox, exist_ok=True)
name = spec["name"]
if "/" in name or name.startswith("."): answer({"ok": False, "why": "bad_name"})
fd, tmp = tempfile.mkstemp(dir=outbox, prefix=".meme-")
with os.fdopen(fd, "wb") as handle: picture.save(handle, "JPEG", quality=88)
os.replace(tmp, os.path.join(outbox, name))
answer({"ok": True, "path": "files/outbox/" + name, "bytes": os.path.getsize(os.path.join(outbox, name)), "font": face_name, "fit": fit})
`;

export interface MemeSpec { template: string; lines: string[] }

export interface MemeRenderInput { template: string; picture: string | null; url: string | null; panel_right: boolean; boxes: MemeBox[]; lines: string[]; name: string; preview?: true }

/** How one box's words came out on the picture (the script's `fit`): `fits` false means they overflow even at the smallest size; `dropped` counts emoji and symbols left off. */
export interface MemeBoxFit { box: number; empty?: true; size?: number; lines?: number; fits?: boolean; smallest?: boolean; width?: number; height?: number; dropped: number }

/**
 * The renderer's input for one meme: the catalog's photo (its path on the image, else its imgflip URL), layout and boxes for the id, the words (one per
 * box, extra ones dropped), and the output file's name. A preview (`preview: true`) is drawn in memory and measured; it writes no file and its name is unused.
 */
export function memeRenderInput(spec: MemeSpec, name: string, options: { preview?: boolean } = {}): MemeRenderInput | null {
  const template = memeTemplate(spec.template);
  if (!template) return null;
  return {
    ...(options.preview ? { preview: true as const } : {}),
    template: template.id,
    picture: template.file ? `${MEME_PICTURES}/${template.file}` : null,
    url: template.file ? null : template.url ?? null,
    panel_right: template.panelRight === true,
    boxes: template.boxes,
    lines: spec.lines.slice(0, template.boxes.length),
    name,
  };
}

/** The image's own Python with Pillow (matplotlib's venv, image/install/install.sh); the system python3 has no Pillow on the brand image. */
export const MEME_PYTHON = "/opt/zygstinct/experience/venv/bin/python";

/**
 * The command a chat runs: the experience venv's Python when it is there (else python3, which answers no_pillow without it) reads the script from stdin; the one
 * argument is the base64 JSON input (no shell quoting of the words).
 */
export function memeRenderCommand(input: NonNullable<ReturnType<typeof memeRenderInput>>): string {
  return `p=${MEME_PYTHON}; [ -x "$p" ] || p=python3; "$p" - ${Buffer.from(JSON.stringify(input), "utf8").toString("base64")}`;
}
