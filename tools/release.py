#!/usr/bin/env python3
"""Build a local, workflow-free release branch from a committed SDK patch set."""

import argparse
import base64
import hashlib
import io
import json
import re
import subprocess
import tempfile
from pathlib import Path
from zipfile import ZipFile

from patchset import ROOT, Failure, apply, binary_diff, clean_base, git, git_text, load_manifest
from patchset import read_json, require, select, status

PACKAGE = '@librechat/agents'
VERSION = re.compile(r'((?:0|[1-9][0-9]*)(?:\.(?:0|[1-9][0-9]*)){2})-ricky\.[1-9][0-9]*')
WORKFLOWS = '.github/workflows'
NPM_INSTALL_FLAGS = ('--ignore-scripts', '--no-audit', '--no-fund')


def check_branch_available(ref):
    local = git_text(ROOT, 'for-each-ref', '--format=%(refname)', ref)
    require(ref not in local.splitlines(), f'Local branch already exists: {ref}')
    remote = subprocess.run(['git', '-C', str(ROOT), 'ls-remote', '--exit-code', '--heads', 'origin', ref],
                            stdout=subprocess.PIPE)
    require(remote.returncode != 0, f'Branch already exists on origin: {ref}')
    require(remote.returncode == 2, f'Could not check {ref} on origin (exit {remote.returncode})')


def check_versions(source, base, version, upstream_version):
    upstream = json.loads(git(source, 'show', f'{base}:package.json'))
    require(upstream['name'] == PACKAGE and upstream['version'] == upstream_version,
            f'Upstream package must be {PACKAGE}@{upstream_version}')
    lock = read_json(source / 'package-lock.json')
    for location, metadata in [('package.json', read_json(source / 'package.json')),
                               ('package-lock.json', lock), ('package-lock.json packages[""]', lock['packages'][''])]:
        require(metadata['name'] == PACKAGE and metadata['version'] == version,
                f'{location}: expected {PACKAGE}@{version}, found {metadata.get("name")}@{metadata.get("version")}')


def commit_tree(source, tree, parent, message):
    return git_text(source, 'commit-tree', tree, '-p', parent, '-m', message)


def generate(snapshot, source, patch_commit, version, upstream_version):
    manifest = load_manifest(snapshot)
    base = manifest['upstream']['commit']
    git(ROOT, '-c', 'submodule.recurse=false', 'worktree', 'add', '--detach', str(source), base)
    generated_tree = apply(snapshot, source, manifest, select(manifest), write=True)
    require(git_text(source, 'write-tree') == generated_tree, 'Staged tree differs from preflight')
    git(source, 'diff', '--cached', '--check')
    check_versions(source, base, version, upstream_version)
    witness = (f'Patchset-Commit: {patch_commit}\nUpstream-Commit: {base}\n'
               f'Generated-Tree: {generated_tree}\nPackage-Version: {version}')
    generated = commit_tree(source, generated_tree, base, f'Replay SDK patches for {version}\n\n{witness}')
    git(source, '-c', 'submodule.recurse=false', 'switch', '--detach', generated)

    removed = git_text(source, 'ls-files', '--', WORKFLOWS).splitlines()
    git(source, 'rm', '-r', '--ignore-unmatch', '--', WORKFLOWS)
    tree = git_text(source, 'write-tree')
    require(not git(source, 'ls-tree', tree, '--', WORKFLOWS), 'Release tree still contains GitHub workflows')
    commit = commit_tree(source, tree, generated, f'Prepare SDK release {version}\n\n{witness}')
    git(source, '-c', 'submodule.recurse=false', 'switch', '--detach', commit)
    clean_base(source, commit)
    return {'commit': commit, 'tree': tree, 'baseCommit': base, 'dirty': False, 'buildState': 'clean-commit'}, {
        'commit': generated, 'tree': generated_tree, 'removedWorkflows': removed,
    }


def pack(source, output, version):
    subprocess.run(['npm', 'ci', *NPM_INSTALL_FLAGS], cwd=source, check=True)
    subprocess.run(['npm', 'run', 'build'], cwd=source, check=True)
    packed, = json.loads(subprocess.check_output(
        ['npm', 'pack', '--ignore-scripts', '--json', '--pack-destination', str(output)], cwd=source))
    filename = f'librechat-agents-{version}.tgz'
    require((packed['name'], packed['version'], packed['filename']) == (PACKAGE, version, filename),
            f'Unexpected package from npm pack. Expected {PACKAGE}@{version} in {filename}')
    archive = (output / filename).read_bytes()
    integrity = 'sha512-' + base64.b64encode(hashlib.sha512(archive).digest()).decode('ascii')
    require(integrity == packed['integrity'], 'Tarball integrity differs from npm pack')
    return {'file': filename, 'sha256': hashlib.sha256(archive).hexdigest(), 'integrity': integrity}


def release(args):
    version = VERSION.fullmatch(args.version)
    require(version, 'Version must be a full X.Y.Z-ricky.N with N >= 1')
    ref = f'refs/heads/release/v{args.version}'
    check_branch_available(ref)
    require(not status(ROOT), 'Run release from a clean maintenance checkout')
    tool_commit = git_text(ROOT, 'rev-parse', 'HEAD')
    patch_commit = git_text(ROOT, 'rev-parse', '--verify', '--end-of-options', f'{args.patch_ref}^{{commit}}')
    snapshot_data = git(ROOT, 'archive', '--format=zip', patch_commit, '--',
                        'manifest.json', 'patches', 'tools/smoke-package.mjs')

    output = args.output.resolve()
    output.mkdir()
    source = output / 'source'
    with tempfile.TemporaryDirectory(prefix='agents-release-') as directory:
        snapshot = Path(directory)
        with ZipFile(io.BytesIO(snapshot_data)) as archive:
            archive.extractall(snapshot)
        release_source, replay = generate(snapshot, source, patch_commit, args.version, version[1])
        tarball = pack(source, output, args.version)
        subprocess.run(['node', str(snapshot / 'tools/smoke-package.mjs'), str(source),
                        str(output / tarball['file']), args.version, tarball['integrity']], cwd=output, check=True)

    clean_base(source, release_source['commit'])
    export_diff = binary_diff(source, release_source['baseCommit'], release_source['commit'])
    patch = f'agents-{args.version}.patch'
    (output / patch).write_bytes(export_diff)
    release_source.update(patch=patch, patchSha256=hashlib.sha256(export_diff).hexdigest())
    record = {
        'package': PACKAGE,
        'version': args.version,
        'branch': ref.removeprefix('refs/heads/'),
        'patchsetCommit': patch_commit,
        'releaseToolCommit': tool_commit,
        'replay': replay,
        'source': release_source,
        'tarball': tarball,
        'node': subprocess.check_output(['node', '--version'], text=True).strip(),
        'npm': subprocess.check_output(['npm', '--version'], text=True).strip(),
    }
    evidence = output / 'release.json'
    pending = output / 'release.json.pending'
    pending.write_text(json.dumps(record, indent=2) + '\n', encoding='utf-8')
    check_branch_available(ref)
    # An empty old value requires the ref to stay absent through the update.
    git(ROOT, 'update-ref', '-m', f'SDK release {args.version}', ref, release_source['commit'], '')
    pending.rename(evidence)
    print(f'Created {record["branch"]} at {release_source["commit"]}\nEvidence: {evidence}')


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('--patch-ref', required=True, help='local maintenance commit or ref')
    parser.add_argument('--version', required=True, help='full fork SemVer, e.g. 4.2.11-ricky.1')
    parser.add_argument('--output', required=True, type=Path, help='new directory for source and artifacts')
    try:
        release(parser.parse_args())
    except (Failure, OSError, ValueError, KeyError, TypeError, subprocess.CalledProcessError) as error:
        parser.exit(1, f'error: {error}\n')


if __name__ == '__main__':
    main()
