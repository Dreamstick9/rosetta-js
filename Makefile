ENV_FILE_FLAG := $(if $(wildcard .env),--env-file=$(CURDIR)/.env)

.PHONY: setup run test

setup:
	@node -e 'const major = Number(process.versions.node.split(".")[0]); if (major < 20) { console.error("Node.js >= 20 is required, found " + process.versions.node); process.exit(1) } console.log("Node.js " + process.versions.node + " OK")'

run:
	@node $(ENV_FILE_FLAG) src/cli.js

test: setup
	@for file in src/*.js; do node --check $$file || exit 1; done
	@dir=$$(mktemp -d) && cd $$dir && node $(ENV_FILE_FLAG) $(CURDIR)/src/cli.js -p "Create hello.txt containing 'hello', read it back, then delete it." && rm -rf $$dir
