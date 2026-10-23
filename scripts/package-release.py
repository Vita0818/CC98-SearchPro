#!/usr/bin/env python3
"""Build an allowlisted release ZIP, npm package and SHA-256 checksum file."""
import hashlib
import json
from pathlib import Path
import subprocess
import tarfile
import zipfile

ROOT = Path(__file__).resolve().parents[1]


def main():
    package = json.loads((ROOT / 'package.json').read_text())
    version = package['version']
    manifest = json.loads((ROOT / '.codex-plugin/plugin.json').read_text())
    if manifest['name'] != 'cc98-searchpro' or manifest['version'] != version:
        raise ValueError('Package and plugin identity/version differ.')
    for path in ['runtime/server.mjs', 'runtime/cli.mjs', 'runtime/THIRD_PARTY_LICENSES.txt', '.agents/plugins/marketplace.json']:
        if not (ROOT / path).is_file():
            raise ValueError(f'Missing release input: {path}')
    output = ROOT / 'release' / f'v{version}'
    output.mkdir(parents=True, exist_ok=True)
    archive_path = output / f'CC98-SearchPro-{version}.zip'
    roots = ['runtime', 'src', 'tests', 'scripts', 'skills', '.codex-plugin', '.agents/plugins/marketplace.json',
             '.mcp.json', 'package.json', 'npm-shrinkwrap.json', 'tsconfig.json', 'tsconfig.tests.json',
             'README.md', 'PRIVACY.md', 'CHANGELOG.md', 'THIRD_PARTY_NOTICES.md', 'LICENSE']
    files = set()
    for root in roots:
        path = ROOT / root
        for item in path.rglob('*') if path.is_dir() else [path]:
            if item.is_symlink():
                raise ValueError('Release inputs must not be symlinks.')
            if item.is_file() and '__pycache__' not in item.parts and item.suffix != '.pyc' and item.name != '.DS_Store':
                files.add(item)
    with zipfile.ZipFile(archive_path, 'w', zipfile.ZIP_DEFLATED, compresslevel=9) as archive:
        for path in sorted(files):
            archive.write(path, 'CC98-SearchPro/' + path.relative_to(ROOT).as_posix())
    command = ['npm', 'pack', '--ignore-scripts', '--silent', '--pack-destination', str(output)]
    result = subprocess.run(command, cwd=ROOT, text=True, stdout=subprocess.PIPE, check=True)
    npm_path = output / result.stdout.strip().splitlines()[-1]
    if npm_path.name != f"{package['name']}-{version}.tgz":
        raise ValueError('Unexpected npm archive identity.')
    with tarfile.open(npm_path) as archive:
        names = archive.getnames()
        if any('/__pycache__/' in n or n.endswith('.pyc') or '/node_modules/' in n or n.endswith('/session.json') or '/.env' in n for n in names):
            raise ValueError('Unexpected cache, dependency directory or local state in npm package.')
        for name in ['package/runtime/server.mjs', 'package/runtime/cli.mjs', 'package/.codex-plugin/plugin.json', 'package/npm-shrinkwrap.json']:
            if name not in names:
                raise ValueError(f'Missing npm release input: {name}')
    checksums = []
    for path in [archive_path, npm_path]:
        checksums.append(hashlib.sha256(path.read_bytes()).hexdigest() + '  ' + path.name)
    (output / 'SHA256SUMS').write_text('\n'.join(checksums) + '\n')
    (output / 'RELEASE_NOTES.md').write_text((ROOT / 'CHANGELOG.md').read_text())
    print(json.dumps({'version': version, 'zip': str(archive_path), 'npm': str(npm_path), 'checksums': str(output / 'SHA256SUMS'), 'files': len(files)}, indent=2))


if __name__ == '__main__':
    main()
