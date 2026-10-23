import importlib.util
import json
from pathlib import Path
import tempfile
import unittest

spec = importlib.util.spec_from_file_location('installer', Path(__file__).resolve().parents[1] / 'scripts/install-local.py')
installer = importlib.util.module_from_spec(spec)
spec.loader.exec_module(installer)


class InstallerTests(unittest.TestCase):
    def setUp(self):
        self.temporary = tempfile.TemporaryDirectory(prefix='cc98-searchpro-installer-')
        self.addCleanup(self.temporary.cleanup)
        self.user = Path(self.temporary.name)
        self.source = self.user / 'CC98-SearchPro'
        (self.source / '.codex-plugin').mkdir(parents=True)
        (self.source / '.codex-plugin/plugin.json').write_text(json.dumps({'name': 'cc98-searchpro'}))
        (self.source / 'runtime').mkdir()
        for name in ['server.mjs', 'cli.mjs']:
            (self.source / 'runtime' / name).write_text('')
        self.market = self.user / '.agents/plugins/marketplace.json'
        self.market.parent.mkdir(parents=True)
        self.other = {'name': 'existing', 'source': {'source': 'local', 'path': './other'}}
        self.market.write_text(json.dumps({'name': 'personal', 'plugins': [self.other]}))

    def test_standalone_install_preserves_other_entries_and_is_idempotent(self):
        plan = installer.prepare(self.source, self.user)
        self.assertEqual(plan['data']['plugins'][0], self.other)
        calls = []
        installer.apply(plan, runner=lambda args, **kwargs: calls.append(args))
        self.assertEqual(calls, [['codex', 'plugin', 'add', 'cc98-searchpro@personal', '--json']])
        self.assertFalse(installer.prepare(self.source, self.user)['write_market'])

    def test_different_source_is_not_replaced(self):
        data = json.loads(self.market.read_text())
        data['plugins'].append({'name': 'cc98-searchpro', 'source': {'source': 'local', 'path': './another'}})
        self.market.write_text(json.dumps(data))
        with self.assertRaisesRegex(ValueError, 'another plugin source'):
            installer.prepare(self.source, self.user)

    def test_incomplete_runtime_requires_build_dependencies(self):
        (self.source / 'runtime/cli.mjs').unlink()
        with self.assertRaisesRegex(ValueError, 'Dependencies are missing'):
            installer.prepare(self.source, self.user)


if __name__ == '__main__':
    unittest.main()
