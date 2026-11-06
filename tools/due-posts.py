#!/usr/bin/env python3
"""Decide whether the hourly Pages run should build the site.

A post dated in the future (Studio's 예약 발행) stays out of the Jekyll build
until its time. Every hour .github/workflows/pages-deploy.yml runs this: if a
post's time came within the last two days but the live site does not serve
its page yet, it prints build=true for $GITHUB_OUTPUT, else build=false.
"""
import http.client
import re
import sys
import time
import urllib.request
from datetime import datetime, timedelta, timezone
from pathlib import Path

SITE = "https://jmchoi4u.github.io"
KST = timezone(timedelta(hours=9))
WINDOW = timedelta(hours=48)
DATE_FORMATS = ("%Y-%m-%d %H:%M:%S %z", "%Y-%m-%d %H:%M %z", "%Y-%m-%d %H:%M:%S", "%Y-%m-%d %H:%M", "%Y-%m-%d")


def front_matter(text):
    if not text.startswith("---\n"):
        return {}
    end = text.find("\n---\n", 4)
    if end == -1:
        return {}
    data = {}
    for line in text[4:end].splitlines():
        if not line or line[0].isspace() or ":" not in line:
            continue
        key, value = line.split(":", 1)
        data[key.strip()] = value.strip().strip("\"'")
    return data


def post_time(value):
    """A front matter date; one without a zone is Korean time, as Jekyll reads it."""
    for fmt in DATE_FORMATS:
        try:
            parsed = datetime.strptime(value.strip(), fmt)
        except ValueError:
            continue
        return parsed if parsed.tzinfo else parsed.replace(tzinfo=KST)
    return None


def is_due(data, now):
    """Out by now and within the window. A hidden post is never built
    (_plugins/hidden-posts-filter.rb), so it is never waited for."""
    if str(data.get("hidden", "false")).lower() == "true":
        return False
    when = post_time(data.get("date", ""))
    return when is not None and now - WINDOW <= when <= now


def post_url(path, data):
    """The page address, by the same rule as notify-subscribers.yml."""
    permalink = data.get("permalink", "").strip()
    if not permalink:
        permalink = "/posts/" + re.sub(r"^\d{4}-\d{2}-\d{2}-", "", path.stem)
    return SITE + "/" + permalink.strip("/") + "/"


def is_live(url):
    # The query string passes the CDN cache by; a network error counts as not live.
    request = urllib.request.Request(f"{url}?due-check={int(time.time())}", method="HEAD")
    try:
        with urllib.request.urlopen(request, timeout=20) as response:
            return 200 <= response.status < 300
    except (OSError, http.client.HTTPException):  # HTTPError (404) is an OSError too
        return False


def main():
    now = datetime.now(timezone.utc)
    for path in sorted(Path("_posts").glob("*.md")):
        data = front_matter(path.read_text(encoding="utf-8"))
        if not is_due(data, now):
            continue
        url = post_url(path, data)
        if not is_live(url):
            print("build=true")
            print(f"due and not live yet: {path} -> {url}", file=sys.stderr)
            return
    print("build=false")
    print("nothing due", file=sys.stderr)


if __name__ == "__main__":
    main()
