#!/bin/sh
# Build qutty.org and publish it to biscuits, where the nginx:alpine container `qutty-site`
# (127.0.0.1:5710, behind the Cloudflare tunnel) serves ~/qutty.org with ~/qutty.org.nginx.conf.
#
#   deno task deploy          # from site/
#
# QUTTY_DEPLOY_HOST overrides the ssh host (default: biscuits).
set -eu

HOST="${QUTTY_DEPLOY_HOST:-biscuits}"
SITE_DIR="$(cd "$(dirname "$0")/.." && pwd)"
cd "$SITE_DIR"

# 1. Build: the static export, then the SEO pass (canonical/OG tags, Markdown twins, sitemap,
#    robots.txt, llms.txt). The OG image is committed; it is drawn again only when missing.
deno task export
deno task seo
if [ ! -f public/og.png ]; then
  deno task og
  cp public/og.png out/og.png
fi

# 2. Sync the export (files gone from out/ are removed there too).
rsync -az --delete out/ "$HOST:qutty.org/"

# 3. The nginx config, then a reload of the container. scp rewrites the file in place, so the
#    container's single-file bind mount keeps seeing it (a rename, as rsync does, would not).
scp -q deploy/nginx.conf "$HOST:qutty.org.nginx.conf"
ssh "$HOST" docker exec qutty-site nginx -s reload

# 4. The site answers 200.
status="$(ssh "$HOST" curl -s -o /dev/null -w '%{http_code}' http://127.0.0.1:5710/)"
if [ "$status" != "200" ]; then
  echo "deploy: http://127.0.0.1:5710/ on $HOST answered $status" >&2
  exit 1
fi
echo "deploy: qutty.org is live ($HOST answered 200)"
