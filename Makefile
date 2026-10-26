# Every check the release workflow runs on a develop -> main pull request, run
# the same way here first. CI's runner has Node 22 already; locally mise gives it.
RUN := $(if $(CI),,mise exec node@22 --)
MANIFEST := plugins/cache-live-control/.claude-plugin/plugin.json

.PHONY: release-check check release

release-check: check release

check: export CLAUDE_CODE_ENABLE_FUNCTION_HOOKS := 1
check:
	$(RUN) npm ci
	$(RUN) npm test
	$(RUN) npm run typecheck
	$(RUN) npm run validate:plugin

# Run `git fetch origin main` first: the version must move past main's.
release:
	$(RUN) scripts/release-check.sh "$$(git show origin/main:$(MANIFEST) 2>/dev/null | $(RUN) node -p 'JSON.parse(require("fs").readFileSync(0, "utf8")).version' 2>/dev/null || echo 0.0.0)"
	v=$$($(RUN) node -p 'require("./$(MANIFEST)").version'); \
	awk -v v="$$v" '$$0 ~ "^## \\[" v "\\]" {f=1; next} /^## \[/ || /^\[/ {f=0} f' CHANGELOG.md | grep -q '' || { echo "FAIL CHANGELOG.md section for $$v yields no release notes"; exit 1; }
