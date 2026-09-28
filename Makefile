# Every CI job and every release step goes through here, so the same command runs locally and in
# Actions. Logic lives in scripts/*.js; this file only names the entry points.

NODE ?= node
NPM  ?= npm
CLAUDE ?= claude
export CLAUDE

# MODEL is forwarded only to the runner. RUN names the immutable cohort used by every result stage.
# Example: make bench-run MODEL=claude-opus-5-5 RUN=opus-5-5-2026-09-28
#          make bench-extract bench-judge RUN=opus-5-5-2026-09-28
BENCH_MODEL_ARG = $(if $(strip $(MODEL)),--model "$(MODEL)")
BENCH_RUN_ARG = $(if $(strip $(RUN)),--run "$(RUN)")

.PHONY: help install test lint check ci validate-plugin eval-parse validate eval release \
	bench-prepare bench-run bench-extract bench-judge bench-report bench-dashboard dashboard-browser-check

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

ci: lint check test dashboard-browser-check ## what a PR has to pass

validate-plugin: ## claude plugin validate
	$(CLAUDE) plugin validate .

eval-parse: ## load every eval case without running one (schema errors fail here)
	$(NODE) scripts/eval-parse.js

validate: check validate-plugin eval-parse ## the ci "validate" job

eval: ## run the eval suite with real model calls; CASE and THRESHOLD override
	$(NODE) scripts/eval.js --case "$(or $(CASE),*)" --threshold "$(or $(THRESHOLD),0.8)"

release: ## bump, verify, commit, tag, push, GitHub release; BUMP=patch|minor|major|X.Y.Z
	$(NODE) scripts/release.js "$(or $(BUMP),patch)"

# The review-tool bake-off. Each result stage is resumable and never replaces a recorded cell;
# choose a new RUN for a fresh cohort. bench-run spends real money on headless review sessions.
bench-prepare: ## republish each benchmark PR into a blinded private repo
	$(NODE) bench/prepare.js $(ARGS)

bench-run: ## run benchmark cohort; MODEL and RUN override its model and id
	$(NODE) bench/run.js $(BENCH_MODEL_ARG) $(BENCH_RUN_ARG) $(ARGS)

bench-extract: ## seal RUN results, then extract them (default: pinned model cohort)
	$(NODE) bench/extract.js $(BENCH_RUN_ARG) $(ARGS)

bench-judge: ## judge RUN findings and finalize complete snapshot
	$(NODE) bench/judge.js $(BENCH_RUN_ARG) $(ARGS)

bench-report: ## write RUN cohort report; default Opus 5.5, RUN=legacy is historical
	$(NODE) bench/report.js --run "$(or $(RUN),claude-opus-5-5)" --write

bench-dashboard: ## render the offline dashboard and GitHub Pages entry point
	@mkdir -p docs
	$(NODE) bench/dashboard.js > docs/index.html
	cp docs/index.html docs/run-explorer.html
	@echo docs/index.html

dashboard-browser-check: bench-dashboard ## render and exercise dashboard routes in headless Chrome
	$(NODE) scripts/dashboard-browser-check.js
