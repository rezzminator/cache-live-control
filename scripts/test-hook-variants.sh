#!/usr/bin/env bash
# Runs hook-tests/<variant>/*.test.ts on the claude-code/testing kit against a
# copy of the installable plugin whose manifest defaults carry the variant's
# options (variant.json): the kit loads the plugin under test with its
# manifest's defaults and has no way to pass options. The installable plugin
# itself is never changed. Needs CLAUDE_CODE_ENABLE_FUNCTION_HOOKS=1.
# Usage: scripts/test-hook-variants.sh [variant...]  (no names: every variant)
set -euo pipefail

root=$(cd "$(dirname "$0")/.." && pwd)
plugin=$root/plugins/cache-live-control
tmp=$(mktemp -d "${TMPDIR:-/tmp}/cache-live-control-variants.XXXXXX")
trap 'rm -rf "$tmp"' EXIT

failed=0
for dir in "$root"/hook-tests/*/; do
  variant=$(basename "$dir")
  if [ "$#" -gt 0 ] && ! printf '%s\n' "$@" | grep -qx "$variant"; then continue; fi
  copy=$tmp/$variant
  mkdir -p "$copy/tests/$variant"
  cp -R "$plugin/." "$copy/"
  rm -f "$copy"/tests/*.test.ts
  cp "$root/hook-tests/world.ts" "$copy/tests/world.ts"
  cp "$dir"*.test.ts "$copy/tests/$variant/"
  manifest=$copy/.claude-plugin/plugin.json
  if ! jq -e --slurpfile v "$dir/variant.json" '($v[0] | keys) - (.userConfig | keys) == []' "$manifest" >/dev/null; then
    echo "ERROR variant $variant names an option the manifest does not have: $(cat "$dir/variant.json")" >&2
    exit 2
  fi
  jq --slurpfile v "$dir/variant.json" '.userConfig |= with_entries(.key as $k | .value.default = (if $v[0] | has($k) then $v[0][$k] else .value.default end))' "$manifest" > "$manifest.new"
  mv "$manifest.new" "$manifest"
  echo "== variant $variant: $(jq -c . "$dir/variant.json")"
  (cd "$copy" && claude plugin test .) || failed=1
done
exit $failed
