ENV_FILE_FLAG := $(if $(wildcard .env),--env-file=$(CURDIR)/.env)
SMOKE_TASK := Create hello.txt containing hello, show it with the bash tool using cat, then delete hello.txt.

.PHONY: setup run test clean

setup:
	@node -e 'const major = Number(process.versions.node.split(".")[0]); if (major < 20) { console.error("Node.js >= 20 is required, found " + process.versions.node); process.exit(1) } console.log("Node.js " + process.versions.node + " OK")'
	@if command -v rg >/dev/null; then echo "ripgrep found"; else echo "ripgrep not found; search uses the built-in fallback"; fi

run:
	@node $(ENV_FILE_FLAG) src/cli.js

test: setup
	@for file in src/*.js src/tools/*.js; do node --check $$file || exit 1; done
	@dir=$$(mktemp -d) && cd $$dir && node $(ENV_FILE_FLAG) $(CURDIR)/src/cli.js -p "$(SMOKE_TASK)" && rm -rf $$dir

clean:
	rm -rf runs
