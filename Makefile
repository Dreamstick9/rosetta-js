LOCAL_NODE := $(CURDIR)/.tools/node/bin/node
NODE = $(shell if [ -x "$(LOCAL_NODE)" ]; then echo "$(LOCAL_NODE)"; else echo node; fi)
ENV_FILE_FLAG := $(if $(wildcard .env),--env-file=$(CURDIR)/.env)

export REPO REPO_PATH ISSUE

.PHONY: setup run test clean

setup:
	@bash scripts/setup.sh

run:
	@"$(NODE)" $(ENV_FILE_FLAG) src/cli.js

test: setup
	@for file in $$(find src test -name '*.js'); do "$(NODE)" --check $$file || exit 1; done
	@bash -n scripts/setup.sh
	@echo "syntax check OK"
	@"$(NODE)" $(ENV_FILE_FLAG) test/smoke.js

clean:
	rm -rf runs .tools /tmp/rjs-*
