#!/usr/bin/env bash
# Pushes this folder to GitHub. Usage: ./push-to-github.sh [repo-name]
set -euo pipefail
cd "$(dirname "$0")"
USER_NAME="swapnilshinde123"
REPO="${1:-palmonas-command-center}"
URL="https://github.com/$USER_NAME/$REPO.git"

command -v git >/dev/null || { echo "Git isn't installed. Run: xcode-select --install"; exit 1; }
# Secrets and local runtime files must never be committed.
for f in .env .local node_modules; do grep -qx "$f" .gitignore || echo "$f" >> .gitignore; done

if [ ! -d .git ]; then git init -b main >/dev/null; fi
git config user.name  >/dev/null || git config user.name  "$USER_NAME"
git config user.email >/dev/null || git config user.email "$USER_NAME@users.noreply.github.com"
git add -A
git commit -m "Palmonas Command Center" >/dev/null 2>&1 || echo "Nothing new to commit."
git branch -M main
if git remote get-url origin >/dev/null 2>&1; then git remote set-url origin "$URL"; else git remote add origin "$URL"; fi

echo "Pushing to $URL"
echo "If Git asks for a password, paste a GitHub personal access token (not your GitHub password)."
git push -u origin main
echo "Done: https://github.com/$USER_NAME/$REPO"
