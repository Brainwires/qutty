#!/bin/sh
# Build, sign and install Qutty into /Applications in one command:
#   deno task install
# Signing identity: a "Developer ID Application" certificate if the keychain has one, otherwise
# "Apple Development" (fine for this Mac). Notarizes only when DENEXT_NOTARY_PROFILE (or the
# DENEXT_NOTARY_KEY/_KEY_ID/_ISSUER API key) is set, which needs a Developer ID certificate.
set -eu
cd "$(dirname "$0")/.."

pick() { security find-identity -v -p codesigning | sed -n "s/.*\"\($1[^\"]*\)\".*/\1/p" | head -1; }
ID="${DENEXT_CODESIGN_IDENTITY:-$(pick 'Developer ID Application')}"
[ -n "$ID" ] || ID="$(pick 'Apple Development')"
[ -n "$ID" ] || { echo "No code-signing identity in the keychain." >&2; exit 1; }
echo "Signing with: $ID"

# Notarization: an App Store Connect API key described in ~/.appstoreconnect/notary.env
# (DENEXT_NOTARY_PROFILE=<notarytool keychain profile>), kept out of the repo.
NOTARY_ENV="${NOTARY_ENV:-$HOME/.appstoreconnect/notary.env}"
case "$ID" in
  "Developer ID Application"*)
    if [ -f "$NOTARY_ENV" ]; then
      set -a; . "$NOTARY_ENV"; set +a
      echo "Notarizing with profile ${DENEXT_NOTARY_PROFILE:-?}"
    fi ;;
esac

DENEXT_CODESIGN_IDENTITY="$ID" deno task desktop:package

APP="dist/Qutty.app"
codesign --verify --deep --strict "$APP"
spctl -a -t exec -vv "$APP" || echo "(Gatekeeper: not notarized; it still runs on this Mac)"
pkill -f "/Applications/Qutty.app/" 2>/dev/null || true
rm -rf "/Applications/Qutty.app"
ditto "$APP" "/Applications/Qutty.app"
echo "Installed /Applications/Qutty.app"
