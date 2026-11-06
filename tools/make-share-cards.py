#!/usr/bin/env python3
"""Draw a share card (og:image) for every post without a cover photo.

KakaoTalk, messages and SNS show a post's og:image when its link is sent.
Most posts have no cover, so every link used to show the same profile
picture. Before the Jekyll build, .github/workflows/pages-deploy.yml runs this
to draw a 1200x630 card per post, its category and title in the blog's sky
palette, into assets/img/og/<file name, slugified as Jekyll does>.png (not
committed). _includes/head.html uses the card when the build has one, so
without Pillow or the font the site simply keeps the old picture.

    python3 tools/make-share-cards.py --font Pretendard-Bold.otf
"""
import argparse
import json
import re
from pathlib import Path

from PIL import Image, ImageDraw, ImageFont

ROOT = Path(__file__).resolve().parent.parent
OUT = ROOT / "assets" / "img" / "og"
AVATAR = ROOT / "assets" / "img" / "profile" / "kindness-avatar.png"

W, H = 1200, 630
FRAME = (175, 196, 215)  # --jm-cover, the sky behind the mascot
CARD = (255, 255, 255)
TITLE = (27, 31, 36)  # --jm-title
ACCENT = (47, 93, 138)  # --jm-accent
SUB = (93, 102, 112)  # --jm-sub
META = (95, 105, 119)  # --jm-meta
# The font has no emoji; drawing one would leave an empty box.
EMOJI = re.compile("[\U0001F000-\U0001FAFF☀-➿⬀-⯿️‍]")


def scalar(value):
    value = value.strip()
    if len(value) >= 2 and value[0] == value[-1] == '"':
        try:
            return json.loads(value)
        except ValueError:
            return value[1:-1]
    if len(value) >= 2 and value[0] == value[-1] == "'":
        return value[1:-1].replace("''", "'")
    return value


def front_matter(text):
    """Top-level keys of a post's front matter; lists for categories."""
    if not text.startswith("---\n"):
        return {}
    end = text.find("\n---\n", 4)
    if end == -1:
        return {}
    data, key = {}, None
    for line in text[4:end].splitlines():
        item = re.match(r"^\s+-\s*(.+)$", line)
        if item and key:
            data.setdefault(key, []).append(scalar(item.group(1)))
            continue
        pair = re.match(r"^([\w-]+):\s*(.*)$", line)
        if not pair:
            continue
        key, value = pair.group(1), pair.group(2).strip()
        if value.startswith("[") and value.endswith("]"):
            data[key] = [scalar(part) for part in value[1:-1].split(",") if part.strip()]
        elif value:
            data[key] = scalar(value)
            key = None
        else:
            data[key] = []
    return data


def category_label(categories):
    """The label the blog puts above a post's title (_layouts/post.html)."""
    categories = categories if isinstance(categories, list) else [categories]
    sub = [c for c in categories if c not in ("writing", "dev")]
    if sub:
        return sub[0]
    return "개발" if "dev" in categories else "글"


def slugify(text):
    """Jekyll's default slugify: runs of anything but letters and digits become '-'."""
    return re.sub(r"[\W_]+", "-", text).strip("-").lower()


def site_title():
    for line in (ROOT / "_config.yml").read_text(encoding="utf-8").splitlines():
        if line.startswith("title:"):
            return scalar(line.split(":", 1)[1].split(" #", 1)[0])
    return ""


def wrap(text, font, width, max_lines):
    """Breaks at spaces like word-break: keep-all; a word too long breaks anywhere."""
    lines, line = [], ""
    for word in text.split():
        candidate = word if not line else line + " " + word
        if font.getlength(candidate) <= width:
            line = candidate
            continue
        if line:
            lines.append(line)
        while font.getlength(word) > width:
            cut = len(word)
            while cut > 1 and font.getlength(word[:cut]) > width:
                cut -= 1
            lines.append(word[:cut])
            word = word[cut:]
        line = word
    if line:
        lines.append(line)
    if len(lines) > max_lines:
        lines = lines[:max_lines]
        last = lines[-1]
        while last and font.getlength(last + "…") > width:
            last = last[:-1]
        lines[-1] = last.rstrip() + "…"
    return lines


def round_avatar(size):
    face = Image.open(AVATAR).convert("RGBA").resize((size, size), Image.LANCZOS)
    mask = Image.new("L", (size * 4, size * 4), 0)
    ImageDraw.Draw(mask).ellipse((0, 0, size * 4 - 1, size * 4 - 1), fill=255)
    face.putalpha(mask.resize((size, size), Image.LANCZOS))
    return face


def draw_card(title, label, blog, font_path, avatar):
    image = Image.new("RGB", (W, H), FRAME)
    draw = ImageDraw.Draw(image)
    draw.rounded_rectangle((40, 40, W - 40, H - 40), radius=32, fill=CARD)

    left, right = 112, W - 112
    width = right - left
    draw.text((left, 104), label, font=ImageFont.truetype(font_path, 36), fill=ACCENT)

    title = EMOJI.sub("", title).strip()
    for size in (76, 68, 60):
        font = ImageFont.truetype(font_path, size)
        lines = wrap(title, font, width, 3)
        if len(lines) <= 2 or size == 60:
            break
    line_height = int(size * 1.34)
    y = 170
    for line in lines:
        draw.text((left, y), line, font=font, fill=TITLE)
        y += line_height

    image.paste(avatar, (left, H - 40 - 64 - avatar.height), avatar)
    name_font = ImageFont.truetype(font_path, 32)
    meta_font = ImageFont.truetype(font_path, 24)
    text_x = left + avatar.width + 22
    draw.text((text_x, H - 40 - 64 - avatar.height + 6), blog, font=name_font, fill=SUB)
    draw.text((text_x, H - 40 - 64 - avatar.height + 48), "jmchoi4u.github.io", font=meta_font, fill=META)
    return image


def main():
    parser = argparse.ArgumentParser(description=__doc__.splitlines()[0])
    parser.add_argument("--font", required=True, help="a Korean font file (OTF or TTF)")
    args = parser.parse_args()

    OUT.mkdir(parents=True, exist_ok=True)
    blog = EMOJI.sub("", site_title()).strip()
    avatar = round_avatar(84)
    made = 0
    for path in sorted((ROOT / "_posts").glob("*.md")):
        data = front_matter(path.read_text(encoding="utf-8"))
        # A cover photo is the share image already.
        if "image" in data or not data.get("title"):
            continue
        card = draw_card(str(data["title"]), category_label(data.get("categories", [])), blog, args.font, avatar)
        card.save(OUT / f"{slugify(path.stem)}.png", optimize=True)
        made += 1
    print(f"share cards: {made}")


if __name__ == "__main__":
    main()
