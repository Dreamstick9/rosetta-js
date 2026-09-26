ENV_FILE_FLAG := $(if $(wildcard .env),--env-file=$(CURDIR)/.env)
NODE := PATH="$(CURDIR)/.tools/node/bin:$$PATH" node

export REPO REPO_PATH ISSUE

.PHONY: setup run test clean eval eval-quick eval-check

setup:
	@bash scripts/setup.sh

run:
	@$(NODE) $(ENV_FILE_FLAG) src/cli.js

test: setup
	@for file in $$(find src test -name '*.js'); do $(NODE) --check $$file || exit 1; done
	@bash -n scripts/setup.sh
	@echo "syntax check OK"
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
