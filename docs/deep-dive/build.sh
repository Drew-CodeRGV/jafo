#!/usr/bin/env bash
# Rebuild the three WLPC Deep Dive PDFs from their HTML sources.
#
#   bash docs/deep-dive/build.sh            # all three
#   bash docs/deep-dive/build.sh proposal   # just one (prefix of the .html name)
#
# Needs Node and Playwright's headless Chromium. Override the defaults with
# PLAYWRIGHT_CORE=/path/to/playwright-core and CHROME_BIN=/path/to/chrome.
# Fonts: Liberation Sans + DejaVu Sans Mono (apt: fonts-liberation fonts-dejavu-core).
set -euo pipefail
cd "$(dirname "${BASH_SOURCE[0]}")"
node build.mjs "$@"
for f in jafo-deep-dive-*.pdf; do
  if command -v pdfinfo >/dev/null 2>&1; then
    printf '  %-40s %s pages\n' "$f" "$(pdfinfo "$f" | awk '/^Pages:/{print $2}')"
  fi
done
