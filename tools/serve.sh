#!/usr/bin/env bash
# Local Jekyll dev server.
# Pins Homebrew ruby@3.3 (the theme requires ~> 3.1) and forces a UTF-8 locale,
# without which entry_filter chokes on the Korean `설명서` exclude path.
set -e
cd "$(dirname "$0")/.."
export PATH="/opt/homebrew/opt/ruby@3.3/bin:$PATH"
export LANG="${LANG:-en_US.UTF-8}"
export LC_ALL="${LC_ALL:-en_US.UTF-8}"
exec bundle exec jekyll serve --host 127.0.0.1 --port 4000 --livereload "$@"
