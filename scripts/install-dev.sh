#!/bin/sh
# Copy the built plugin into the bundled dev vault (open dev-vault/ as a vault in Obsidian).
set -e
cd "$(dirname "$0")/.."
node scripts/build.js
dest=dev-vault/.obsidian/plugins/wheelhouse-task-view
mkdir -p "$dest"
cp manifest.json main.js styles.css "$dest/"
echo "Installed into $dest"
