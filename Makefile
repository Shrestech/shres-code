# Shres Code web app lifecycle. The app is `pnpm shres web` (source launch
# through tsx) serving the built frontend on 127.0.0.1:3080. Pid and log live
# under .run/, which git ignores.

SHELL := /bin/sh
RUN_DIR := .run
PID_FILE := $(RUN_DIR)/web.pid
LOG_FILE := $(RUN_DIR)/web.log
URL := http://127.0.0.1:3080
START_TIMEOUT := 15

.PHONY: help start stop restart status logs build

help: ## Show available targets
	@grep -E '^[a-zA-Z_-]+:.*?## ' $(MAKEFILE_LIST) | awk 'BEGIN {FS = ":.*?## "}; {printf "  make %-10s %s\n", $$1, $$2}'

build: ## Build lib + web dist (required once before start, and after pulls)
	pnpm run build

start: ## Start the web app in the background
	@mkdir -p $(RUN_DIR)
	@if [ -f $(PID_FILE) ] && kill -0 $$(cat $(PID_FILE)) 2>/dev/null; then \
		echo "already running, pid $$(cat $(PID_FILE)) — $(URL) (make logs to follow)"; \
		exit 0; \
	fi
	@rm -f $(PID_FILE)
	@echo "starting shres web -> $(URL)"
	@nohup pnpm shres web > $(LOG_FILE) 2>&1 & \
		echo $$! > $(PID_FILE)
	@i=0; \
	while [ $$i -lt $(START_TIMEOUT) ]; do \
		if curl -sf -o /dev/null $(URL) && kill -0 $$(cat $(PID_FILE)) 2>/dev/null; then \
			sleep 1; \
			if ! kill -0 $$(cat $(PID_FILE)) 2>/dev/null; then continue; fi; \
			echo "up, pid $$(cat $(PID_FILE)): $(URL)"; exit 0; \
		fi; \
		if ! kill -0 $$(cat $(PID_FILE)) 2>/dev/null; then \
			echo "exited during startup; last log lines:"; tail -20 $(LOG_FILE); \
			rm -f $(PID_FILE); exit 1; \
		fi; \
		i=$$((i + 1)); sleep 1; \
	done; \
	echo "not answering after $(START_TIMEOUT)s; still booting? log: $(LOG_FILE)"; exit 1

stop: ## Stop the web app (SIGTERM, then SIGKILL after 5s)
	@if [ ! -f $(PID_FILE) ]; then echo "not running (no $(PID_FILE))"; exit 0; fi; \
	pid=$$(cat $(PID_FILE)); \
	if ! kill -0 $$pid 2>/dev/null; then echo "stale pidfile removed"; rm -f $(PID_FILE); exit 0; fi; \
	echo "stopping pid $$pid"; \
	kill $$pid; \
	i=0; while kill -0 $$pid 2>/dev/null && [ $$i -lt 5 ]; do i=$$((i + 1)); sleep 1; done; \
	if kill -0 $$pid 2>/dev/null; then echo "force-killing"; kill -9 $$pid; sleep 1; fi; \
	rm -f $(PID_FILE); \
	echo "stopped"

restart: stop start ## Restart the web app

status: ## Show pid and whether the app answers
	@if [ -f $(PID_FILE) ] && kill -0 $$(cat $(PID_FILE)) 2>/dev/null; then \
		echo "running, pid $$(cat $(PID_FILE))"; \
	else \
		echo "not running"; exit 1; \
	fi; \
	if curl -sf -o /dev/null $(URL); then echo "serving $(URL)"; else echo "no answer on $(URL)"; fi

logs: ## Follow the app log (Ctrl-C to detach; the app keeps running)
	tail -f $(LOG_FILE)
