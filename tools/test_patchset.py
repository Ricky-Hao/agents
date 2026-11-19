import json
import tempfile
import unittest
from pathlib import Path

from patchset import Failure, apply, git, git_text, load_manifest, select, status


class PatchsetTests(unittest.TestCase):
    def setUp(self):
        directory = tempfile.TemporaryDirectory()
        self.addCleanup(directory.cleanup)
        self.root = Path(directory.name)
        self.sdk = self.root / 'sdk'
        self.sdk.mkdir()
        self.file = self.sdk / 'example.txt'
        self.file.write_text('base\n')
        git(self.sdk, 'init', '-q')
        git(self.sdk, 'add', 'example.txt')
        git(self.sdk, '-c', 'user.name=Fixture', '-c', 'user.email=fixture@example.invalid',
            'commit', '-qm', 'base')
        self.base = git_text(self.sdk, 'rev-parse', 'HEAD')
        self.base_tree = git_text(self.sdk, 'write-tree')

    def patch(self, name, old, new, *depends_on):
        path = self.root / 'patches' / name
        path.mkdir(parents=True)
        (path / 'changes.patch').write_text(
            'diff --git a/example.txt b/example.txt\n--- a/example.txt\n+++ b/example.txt\n'
            f'@@ -1 +1 @@\n-{old}\n+{new}\n')
        return {'id': name, 'status': 'keep', 'summary': name, 'depends_on': list(depends_on)}

    def manifest(self, *entries):
        (self.root / 'manifest.json').write_text(json.dumps({
            'schema_version': 1, 'upstream': {'ref': 'v1.0.0', 'commit': self.base}, 'patches': entries,
        }))
        return load_manifest(self.root)

    def test_selection_follows_dependency_order_and_apply_stages_net_diff(self):
        manifest = self.manifest(self.patch('first', 'base', 'step one'),
                                 self.patch('second', 'step one', 'step two', 'first'),
                                 self.patch('third', 'step two', 'done', 'second'))
        selection = select(manifest, ['third'])
        self.assertEqual(['first', 'second', 'third'], [entry['id'] for entry in selection])
        checked = apply(self.root, self.sdk, manifest, selection)
        self.assertEqual(b'', status(self.sdk))
        self.assertEqual('base\n', self.file.read_text())
        self.assertEqual(checked, apply(self.root, self.sdk, manifest, selection, write=True))
        self.assertEqual(checked, git_text(self.sdk, 'write-tree'))
        self.assertEqual('done\n', self.file.read_text())
        self.assertEqual(b'done\n', git(self.sdk, 'show', ':example.txt'))

    def test_late_conflict_preserves_real_index_and_worktree(self):
        manifest = self.manifest(self.patch('first', 'base', 'step one'),
                                 self.patch('conflict', 'different context', 'done', 'first'))
        with self.assertRaisesRegex(Failure, 'Preflight stopped at conflict'):
            apply(self.root, self.sdk, manifest, select(manifest), write=True)
        self.assertEqual('base\n', self.file.read_text())
        self.assertEqual(self.base_tree, git_text(self.sdk, 'write-tree'))
        self.assertEqual(b'', status(self.sdk))

    def test_dirty_target_is_rejected(self):
        manifest = self.manifest(self.patch('first', 'base', 'patched'))
        self.file.write_text('local edit\n')
        with self.assertRaisesRegex(Failure, 'Target has changes'):
            apply(self.root, self.sdk, manifest, select(manifest), write=True)
        self.assertEqual('local edit\n', self.file.read_text())

    def test_upstream_retirement_requires_commit_in_the_fixed_base(self):
        future = git_text(self.sdk, '-c', 'user.name=Fixture', '-c', 'user.email=fixture@example.invalid',
                          'commit-tree', self.base_tree, '-p', self.base, '-m', 'future')
        entry = {'id': 'retired', 'status': 'upstream', 'summary': 'retirement fixture', 'depends_on': [],
                 'replacement': {'commit': future, 'evidence': 'fixture'}}
        manifest = self.manifest(entry)
        with self.assertRaisesRegex(Failure, 'cannot verify upstream replacement'):
            apply(self.root, self.sdk, manifest, select(manifest))
        self.base = future
        git(self.sdk, 'switch', '--detach', future)
        manifest = self.manifest(entry)
        self.assertEqual([], select(manifest))
        self.assertEqual(self.base_tree, apply(self.root, self.sdk, manifest, select(manifest), write=True))


if __name__ == '__main__':
    unittest.main()
