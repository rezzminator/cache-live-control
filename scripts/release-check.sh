#!/usr/bin/env bash
# Release integrity: the version agrees in every place that carries it, and
# CHANGELOG.md has a dated section for it. With a base version argument (the
# version on main), the version must also have moved past it.
# Prints one line per failure and exits 1; exits 2 when a file cannot be read.
set -uo pipefail
cd "$(dirname "$0")/.."
read_json() { node -e 'const [f, e] = process.argv.slice(1); const j = JSON.parse(require("fs").readFileSync(f, "utf8")); process.stdout.write(String(e.split(".").reduce((o, k) => o?.[k], j) ?? ""))' "$1" "$2" || { echo "ERROR cannot read $1"; exit 2; }; }
v=$(read_json plugins/cache-live-control/.claude-plugin/plugin.json version)
[ -n "$v" ] || { echo "ERROR plugin.json has no version"; exit 2; }
fail=0
m=$(node -e 'const j = require("./.claude-plugin/marketplace.json"); process.stdout.write(j.plugins.find((p) => p.name === "cache-live-control")?.version ?? "")') || { echo "ERROR cannot read marketplace.json"; exit 2; }
p=$(read_json package.json version)
b=$(grep -oE 'badge/version-[0-9.]+-' README.md | sed -E 's/badge\/version-|-$//g')
[ "$m" = "$v" ] || { echo "FAIL marketplace.json says $m, plugin.json $v"; fail=1; }
[ "$p" = "$v" ] || { echo "FAIL package.json says $p, plugin.json $v"; fail=1; }
[ "$b" = "$v" ] || { echo "FAIL README badge says ${b:-nothing}, plugin.json $v"; fail=1; }
grep -qE "^## \[$v\] — [0-9]{4}-[0-9]{2}-[0-9]{2}$" CHANGELOG.md || { echo "FAIL CHANGELOG.md has no dated section for $v"; fail=1; }
if [ -n "${1:-}" ]; then
  newest=$(printf '%s\n%s\n' "$1" "$v" | sort -V | tail -1)
  { [ "$v" != "$1" ] && [ "$newest" = "$v" ]; } || { echo "FAIL version $v has not moved past main's $1"; fail=1; }
fi
[ $fail -eq 0 ] && echo "PASS release $v: versions agree, CHANGELOG dated${1:+, past $1}"
exit $fail
