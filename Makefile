ENV_FILE_FLAG := $(if $(wildcard .env),--env-file=$(CURDIR)/.env)
NODE := PATH="$(CURDIR)/.tools/node/bin:$$PATH" node

export REPO REPO_PATH TARGET_REPO WORK_DIR ISSUE

.PHONY: setup run chat test clean eval eval-quick eval-check

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
	@AI_API_KEY=unused $(NODE) test/loop.js
	@AI_API_KEY=unused $(NODE) test/repair.js
	@AI_API_KEY=unused $(NODE) test/skills-internal.js
	@AI_API_KEY=unused $(NODE) test/orchestrator.js
	@$(NODE) $(ENV_FILE_FLAG) test/smoke.js

eval:
	@$(NODE) evals/run.js $(EVAL_ARGS)

eval-quick:
	@$(NODE) evals/run.js --quick $(EVAL_ARGS)

eval-check:
	@$(NODE) evals/run.js --oracle gold --parallel 4 $(EVAL_ARGS)
	@$(NODE) evals/run.js --oracle none --parallel 4 $(EVAL_ARGS)

clean:
	rm -rf runs .tools /tmp/rjs-*
