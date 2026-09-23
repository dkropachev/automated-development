# Every CI job and every release step goes through here, so the same command runs locally and in
# Actions. Logic lives in scripts/*.js; this file only names the entry points.

NODE ?= node
NPM  ?= npm
CLAUDE ?= claude

.PHONY: help install test lint check ci validate-plugin eval-parse validate eval release \
	bench-prepare bench-run bench-extract bench-judge bench-report bench-dashboard

help:
	@$(NODE) -e "const fs=require('fs');for(const l of fs.readFileSync('Makefile','utf8').split('\n')){const m=/^([a-z-]+):.*## (.*)$$/.exec(l);if(m)console.log(m[1].padEnd(16),m[2])}"

install: ## npm ci
	$(NPM) ci

test: ## unit + end-to-end driver tests
	$(NODE) --test test/*.test.js

lint: ## eslint + node --check on every script
	$(NPM) run lint
	$(NODE) scripts/syntax-check.js

check: ## prose/code drift, version agreement, frontmatter
	$(NODE) scripts/check-consistency.js

ci: lint check test ## what a PR has to pass

validate-plugin: ## claude plugin validate
	$(CLAUDE) plugin validate .

eval-parse: ## load every eval case without running one (schema errors fail here)
	$(NODE) scripts/eval-parse.js

validate: check validate-plugin eval-parse ## the ci "validate" job

eval: ## run the eval suite with real model calls; CASE and THRESHOLD override
	$(NODE) scripts/eval.js --case "$(or $(CASE),*)" --threshold "$(or $(THRESHOLD),0.8)"

release: ## bump, verify, commit, tag, push, GitHub release; BUMP=patch|minor|major|X.Y.Z
	$(NODE) scripts/release.js "$(or $(BUMP),patch)"

# The review-tool bake-off. Each step is resumable and skips work already on disk; pass ARGS="--force"
# to redo one. bench-run spends real money - it is a matrix of headless `claude -p` review sessions.
bench-prepare: ## republish each benchmark PR into a blinded private repo
	$(NODE) bench/prepare.js $(ARGS)

bench-run: ## run every review tool against every benchmark PR
	$(NODE) bench/run.js $(ARGS)

bench-extract: ## turn each tool's prose report into comparable findings
	$(NODE) bench/extract.js $(ARGS)

bench-judge: ## merge and verify the findings against the code, per PR
	$(NODE) bench/judge.js $(ARGS)

bench-report: ## render docs/review-bakeoff.md from what is on disk
	@mkdir -p docs
	$(NODE) bench/report.js > docs/review-bakeoff.md
	@echo docs/review-bakeoff.md

bench-dashboard: ## render the offline dashboard and GitHub Pages entry point
	@mkdir -p docs
	$(NODE) bench/dashboard.js > docs/index.html
	cp docs/index.html docs/run-explorer.html
	@echo docs/index.html
