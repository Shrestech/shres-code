# Agent Note: Default-mount stateless `run_code` in the advanced analysis profile

Status: implemented

## Problem

The stateless `run_code` tool exists and the advanced headless analysis profile already selects `tools.mode: both` with a mounted code-runtime, but the SDK instructions never told the model to compute over a corpus in one program instead of issuing N `read` calls. A kernel-class win on data-heavy tasks could not be distinguished from "the model never tried code-mode compute."

## Decision

The advanced analysis profile (`examples/headless-agent/advanced.cordis.yml`) keeps Code Mode mounted (`mode: both` plus `code-runtime`). The base bundle does not. The TypeScript and Python SDK instruction blocks include one compute-don't-read line: when a task needs reading many files or computing over data, prefer one `run_code` program that loads and computes over a corpus instead of N `read` calls.

This measures adoption of stateless code-mode compute. It bounds the kernel's **floor**, not its ceiling. A win here is not kernel evidence.

This is [roadmap WP1.7](../../proposed/feature/2026-08-26-beat-prime-agent-roadmap.md).

## Alternatives considered

**Mount `run_code` in the base bundle.** Rejected — the default-off constitution holds for the bench. The analysis profile is the product decision.

**Put the guidance only in the advanced persona.** Rejected — the SDK section is the code-mode contract the model reads when writing a program; a persona line is easier to ignore at the moment of a `read` storm.

**Treat a WP1.7 win as kernel evidence.** Rejected — persistent slots, residency, and recycle/rehydrate are unmeasured here. The kernel's ceiling needs the WP3.3 `code` vs `read` arm and, if that shows need, WP2.1.

## Consequences

Every `code` or `both` composition sees the extra SDK line, including ACP code-mode snapshots. The base native-only bundle does not. Snapshot fixtures that pin the SDK instructions include the new line.
