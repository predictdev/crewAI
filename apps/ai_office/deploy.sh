#!/usr/bin/env bash
# Deploy AI Office to Fly.io. The image is built from the repository root
# because the app runs crews on this repo's crewAI source.
set -euo pipefail
cd "$(dirname "$0")/../.."
exec fly deploy . --config apps/ai_office/fly.toml --dockerfile apps/ai_office/Dockerfile "$@"
