#!/bin/sh
set -eu
plugin_dir=$(CDPATH= cd -- "$(dirname -- "$0")/.." && pwd)
if [ -f "$plugin_dir/runtime/server.mjs" ]; then
  exec node "$plugin_dir/runtime/server.mjs"
fi
if [ ! -f "$plugin_dir/dist/server.js" ]; then
  echo 'CC98 搜索插件尚未构建，请在插件目录运行 npm ci --ignore-scripts && npm run build。' >&2
  exit 1
fi
exec node "$plugin_dir/dist/server.js"
