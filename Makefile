.PHONY: dev build

PORT ?= 8000

# Serve the page locally. Browsers will not load its modules from a file.
dev:
	python3 -m http.server $(PORT) --bind 127.0.0.1

# The files to publish: only what the page itself needs.
build:
	rm -rf dist
	mkdir -p dist/src
	install -m 644 index.html dist/
	install -m 644 src/*.js dist/src/
