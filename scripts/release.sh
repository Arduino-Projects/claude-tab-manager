#!/bin/sh
# Tests, builds, and publishes to the VS Code Marketplace and Open VSX.
# Usage: npm run release [-- patch|minor|major]
# Needs a one-time `npx @vscode/vsce login AraadShams`, and the Open VSX token in the
# macOS Keychain under the service name "claude-tab-manager-ovsx".
set -e
cd "$(dirname "$0")/.."
if [ -n "$1" ]; then npm version "$1" --no-git-tag-version; fi
npm test
npm run package
npx --yes @vscode/vsce publish --packagePath claude-tab-manager.vsix
OVSX_PAT="$(security find-generic-password -s claude-tab-manager-ovsx -w)" npx --yes ovsx publish claude-tab-manager.vsix
