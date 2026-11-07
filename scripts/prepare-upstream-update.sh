#!/usr/bin/env bash
# Prepare a review branch. Never replace a tree, push, or alter the base ref.
set -euo pipefail
upstream_ref="${1:?upstream commit/ref required}"
review_branch="${2:?new review branch required}"
if [ -n "$(git status --porcelain)" ]; then
  echo "Working tree must be clean before preparing an update." >&2
  exit 1
fi
git rev-parse --verify "${upstream_ref}^{commit}" >/dev/null
git switch -c "${review_branch}"
if ! git merge --no-ff --no-edit "${upstream_ref}"; then
  git merge --abort
  echo "Upstream conflicts with this fork. Resolve in a development branch; the base branch is unchanged." >&2
  exit 1
fi
