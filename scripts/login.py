#!/usr/bin/env python3
"""Collect CC98 credentials locally without echoing or placing them in argv."""
import getpass
import json
from pathlib import Path
import shutil
import subprocess
import sys


def main():
    root = Path(__file__).resolve().parents[1]
    node = shutil.which('node')
    cli = root / 'runtime' / 'cli.mjs'
    if not cli.is_file():
        cli = root / 'dist' / 'cli.js'
    if not node or not cli.is_file():
        print('请先安装 Node.js 22.18+，并运行 npm ci --ignore-scripts && npm run build。', file=sys.stderr)
        return 1
    if not sys.stdin.isatty():
        print('请在本机交互式终端运行 npm run configure。', file=sys.stderr)
        return 1
    try:
        username = input('CC98 用户名：').strip()
        password = getpass.getpass('CC98 密码（不显示、不保存）：')
        payload = json.dumps({'username': username, 'password': password})
        return subprocess.run([node, str(cli), 'login', '--stdin'], input=payload, text=True).returncode
    except (KeyboardInterrupt, EOFError):
        print('\n登录已取消。', file=sys.stderr)
        return 1


if __name__ == '__main__':
    raise SystemExit(main())
