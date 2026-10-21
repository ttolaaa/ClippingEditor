#!/bin/sh
# Git-polling auto-deployer used by docker-compose.build.yml.
# Every $INTERVAL seconds: fetch $BRANCH; if the remote has new commits, pull, rebuild and recreate the app.
set -eu

BRANCH="${BRANCH:-main}"
INTERVAL="${INTERVAL:-60}"
COMPOSE_FILE="${COMPOSE_FILE:-docker-compose.build.yml}"

log() { echo "[auto-update $(date -u +%Y-%m-%dT%H:%M:%SZ)] $*"; }

apk add --no-cache git >/dev/null 2>&1 || true
git config --global --add safe.directory /repo
git config --global user.email "auto-update@localhost"
git config --global user.name "auto-update"

if [ -n "${GIT_TOKEN:-}" ]; then
  # Use the token for HTTPS fetches without writing it into .git/config.
  git config --global credential.helper '!f() { echo "username=x-access-token"; echo "password=${GIT_TOKEN}"; }; f'
fi

deploy() {
  sha="$(git rev-parse --short HEAD)"
  log "Building and deploying ${sha}…"
  if GIT_SHA="$sha" docker compose -f "$COMPOSE_FILE" up -d --build app; then
    docker image prune -f >/dev/null 2>&1 || true
    log "Deployed ${sha}."
  else
    log "Build failed for ${sha}; keeping the previous version running."
  fi
}

log "Watching origin/${BRANCH} every ${INTERVAL}s."
deploy

while true; do
  sleep "$INTERVAL"
  if ! git fetch --quiet origin "$BRANCH"; then
    log "git fetch failed; will retry."
    continue
  fi
  local_sha="$(git rev-parse HEAD)"
  remote_sha="$(git rev-parse "origin/${BRANCH}")"
  if [ "$local_sha" != "$remote_sha" ]; then
    log "New commit on ${BRANCH}: $(echo "$local_sha" | cut -c1-7) -> $(echo "$remote_sha" | cut -c1-7)"
    git reset --hard --quiet "origin/${BRANCH}"
    deploy
  fi
done
