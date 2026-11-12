# Sourced by build.sh and smoke.sh (from macos/). Copies the built frontend into an app bundle.
install_web() {
  local resources="$1" dist
  if [[ -n "${WEB_DIST:-}" ]]; then
    dist="$WEB_DIST"
  else
    if ! command -v bun >/dev/null; then
      echo "bun is required to build the frontend (or set WEB_DIST to an already built frontend)." >&2
      exit 1
    fi
    # The bundle ships xterm.js from node_modules; a fresh checkout has none yet.
    if [[ ! -d ../node_modules/@xterm/xterm ]]; then
      (cd .. && bun install --frozen-lockfile)
    fi
    (cd .. && bun desktop/build.ts)
    dist=../desktop/dist
  fi
  if [[ ! -f "$dist/index.html" ]]; then
    echo "No index.html in $dist. Build the frontend with 'bun desktop/build.ts' or point WEB_DIST at one." >&2
    exit 1
  fi
  rm -rf "$resources/web"
  ditto "$dist" "$resources/web"
}
