ENV_FILE_FLAG := $(if $(wildcard .env),--env-file=$(CURDIR)/.env)
NODE := PATH="$(CURDIR)/.tools/node/bin:$$PATH" node

export REPO REPO_PATH TARGET_REPO WORK_DIR ISSUE

.PHONY: setup run chat test clean

setup:
	@bash scripts/setup.sh

run:
	@$(NODE) $(ENV_FILE_FLAG) src/cli.js

chat:
	@$(NODE) $(ENV_FILE_FLAG) src/cli.js --chat

test: setup
	@for file in $$(find src test -name '*.js'); do $(NODE) --check $$file || exit 1; done
	@bash -n scripts/setup.sh
	@echo "syntax check OK"
	@AI_API_KEY=unused $(NODE) test/policy.js
	@AI_API_KEY=unused $(NODE) test/skills.js
	@AI_API_KEY=unused $(NODE) test/intake.js
	@AI_API_KEY=unused $(NODE) test/workspace.js
	@$(NODE) $(ENV_FILE_FLAG) test/smoke.js

clean:
	rm -rf runs .tools /tmp/rjs-*
