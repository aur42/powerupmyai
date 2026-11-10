#!/bin/sh
# Worker test suite: invite gate, admin surfaces, and the flag-off
# regression set. The suite itself is run-tests.mjs (stub KV + stub
# GitHub/provider fetches, real Request objects, no network).
# Stable entry point, from the repo root:  sh tests/RUN-TESTS.sh
exec node "$(dirname "$0")/run-tests.mjs" "$@"
