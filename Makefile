# Every CI job and every release step goes through here, so the same command runs locally and in
# Actions. Logic lives in scripts/*.js; this file only names the entry points.

NODE ?= node
NPM  ?= npm
CLAUDE ?= claude

.PHONY: help install test lint check ci validate-plugin eval-parse validate eval release

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
