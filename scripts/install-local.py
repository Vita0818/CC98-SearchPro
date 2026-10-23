#!/usr/bin/env python3
"""Register a plugin at its existing location in the personal Codex marketplace."""
import argparse
import json
from pathlib import Path
import re
import shutil
import subprocess
import sys
import tempfile

PLUGIN = 'cc98-searchpro'

def prepare(source, user_root=None):
    source = Path(source).resolve()
    user_root = (Path(user_root) if user_root is not None else Path.home()).resolve()
    manifest = json.loads((source / '.codex-plugin' / 'plugin.json').read_text())
    if manifest.get('name') != PLUGIN:
        raise ValueError('Plugin identity does not match this installer.')
    bundled = all((source / 'runtime' / name).is_file() for name in ('server.mjs', 'cli.mjs'))
    if not bundled:
        if not (source / 'node_modules' / '@modelcontextprotocol' / 'sdk' / 'package.json').is_file():
            raise ValueError('Dependencies are missing. Use the bundled release or run npm ci --ignore-scripts.')
        if not (source / 'dist' / 'server.js').is_file():
            raise ValueError('Build is missing. Run npm run build first.')
    try:
        relative = source.relative_to(user_root)
    except ValueError:
        raise ValueError('For personal-marketplace installation, keep the source in an existing project or Downloads directory inside your user directory.')
    expected = {'source': 'local', 'path': './' + relative.as_posix()}
    market = user_root / '.agents' / 'plugins' / 'marketplace.json'
    if market.exists():
        data = json.loads(market.read_text())
    else:
        data = {'name': 'personal', 'interface': {'displayName': 'Personal'}, 'plugins': []}
    if not isinstance(data, dict) or not isinstance(data.get('name'), str) or not re.fullmatch(r'[A-Za-z0-9_-]+', data['name']):
        raise ValueError('The existing marketplace has an invalid name.')
    if not isinstance(data.get('plugins'), list):
        raise ValueError('The existing marketplace plugins value is not a list.')
    existing = [p for p in data['plugins'] if isinstance(p, dict) and p.get('name') == PLUGIN]
    if len(existing) > 1:
        raise ValueError('The marketplace contains duplicate entries for this plugin.')
    write_market = False
    if existing:
        entry = existing[0]
        old = entry.get('source')
        if not isinstance(old, dict) or old.get('source') != 'local' or not isinstance(old.get('path'), str):
            raise ValueError('This marketplace contains a different source for this plugin.')
        old_path = old['path']
        if not old_path.startswith('./') or '..' in Path(old_path).parts:
            raise ValueError('The existing marketplace source path is invalid.')
        if (user_root / old_path).resolve() != source:
            raise ValueError('This marketplace already points to another plugin source. It was not overwritten.')
        if old != expected:
            entry['source'] = expected
            write_market = True
    else:
        data['plugins'].append({
            'name': PLUGIN, 'source': expected,
            'policy': {'installation': 'AVAILABLE', 'authentication': 'ON_INSTALL'},
            'category': 'Productivity',
        })
        write_market = True
    # Compatibility cleanup only: never create this old home-directory path.
    legacy = user_root / 'plugins' / PLUGIN
    cleanup = legacy if legacy.is_symlink() and legacy.resolve() == source else None
    return {'source': source, 'market': market, 'source_path': expected['path'],
            'data': data, 'write_market': write_market, 'legacy_link': cleanup,
            'selector': PLUGIN + '@' + data['name']}

def apply(plan, runner=subprocess.run):
    if plan['write_market']:
        plan['market'].parent.mkdir(parents=True, exist_ok=True)
        with tempfile.NamedTemporaryFile(mode='w', encoding='utf-8', dir=plan['market'].parent, delete=False) as f:
            json.dump(plan['data'], f, ensure_ascii=False, indent=2)
            f.write('\n')
            temporary = Path(f.name)
        temporary.chmod(0o600)
        temporary.replace(plan['market'])
    runner(['codex', 'plugin', 'add', plan['selector'], '--json'], check=True)
    # Remove only our verified old symlink, and remove its parent only if empty.
    legacy = plan['legacy_link']
    if legacy and legacy.is_symlink() and legacy.resolve() == plan['source']:
        legacy.unlink()
        try:
            legacy.parent.rmdir()
        except OSError:
            pass

def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('--apply', action='store_true', help='Apply the displayed installation plan.')
    args = parser.parse_args()
    try:
        plan = prepare(Path(__file__).resolve().parents[1])
        print(json.dumps({k: str(plan[k]) for k in ['source', 'source_path', 'market', 'selector']}, ensure_ascii=False, indent=2))
        if args.apply:
            if not shutil.which('codex'):
                raise ValueError('Codex CLI is not available on PATH. Install the Codex CLI before applying.')
            apply(plan)
            print('Installed from the existing source directory. Open a new Codex task to load updates.')
    except (ValueError, OSError, subprocess.CalledProcessError) as error:
        print(str(error), file=sys.stderr)
        return 1
    return 0

if __name__ == '__main__':
    raise SystemExit(main())
