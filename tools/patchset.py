#!/usr/bin/env python3
"""Replay the ordered SDK patch manifest and run its local checks."""

import argparse
import json
import os
import re
import subprocess
import sys
import tempfile
from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]
ACTIVE = {'keep', 'feature', 'local', 'awaiting-upstream'}
STATUSES = ACTIVE | {'upstream', 'replaced', 'retired'}
SHA = re.compile(r'[0-9a-f]{40}')


class Failure(Exception):
    pass


def require(condition, message):
    if not condition:
        raise Failure(message)


def read_json(path):
    return json.loads(path.read_text(encoding='utf-8'))


def git(target, *args, env=None, data=None):
    result = subprocess.run(['git', '-C', str(target), *args], input=data,
                            capture_output=True, env=env)
    if result.returncode:
        raise Failure(f'git {" ".join(args)} failed in {target}:\n'
                      + result.stderr.decode(errors='replace').rstrip())
    return result.stdout


def git_text(target, *args, **kwargs):
    return git(target, *args, **kwargs).decode().strip()


def binary_diff(target, before, after):
    return git(target, 'diff', '--binary', '--full-index', '--no-ext-diff', '--no-textconv',
               '--no-renames', '--no-color', '--src-prefix=a/', '--dst-prefix=b/',
               '--submodule=short', '--ignore-submodules=none', before, after, '--')


def patch_path(root, entry):
    return root / 'patches' / entry['id'] / 'changes.patch'


def validate_retirement(entry, active_ids):
    name = entry['id']
    replacement = entry['replacement']
    require(bool(replacement['evidence'].strip()), f'Retirement evidence missing: {name}')
    if entry['status'] == 'upstream':
        require(SHA.fullmatch(replacement['commit']), f'Full upstream replacement SHA required: {name}')
    if entry['status'] == 'replaced':
        require(replacement['patch'] in active_ids, f'Active replacement patch required: {name}')


def validate_checks(entry):
    for path in entry.get('jest', []):
        parts = Path(path).parts
        require(parts[0:1] == ('src',) and '..' not in parts and
                path.endswith(('.test.ts', '.spec.ts')), f'Invalid Jest path: {path}')
    for command in entry.get('commands', []):
        require(isinstance(command, list) and command and
                all(isinstance(arg, str) and arg for arg in command),
                f'Expected a nonempty argument array: {entry["id"]}')


def load_manifest(root=ROOT):
    manifest = read_json(root / 'manifest.json')
    require(manifest['schema_version'] == 1, 'Unsupported manifest format')
    require(SHA.fullmatch(manifest['upstream']['commit']), 'Upstream must be a full commit SHA')
    require(bool(manifest['upstream']['ref'].strip()), 'Upstream reference missing')
    entries = manifest['patches']
    active_ids = {entry['id'] for entry in entries if entry['status'] in ACTIVE}
    seen = set()
    expected_payloads = set()
    for entry in entries:
        name = entry['id']
        require(re.fullmatch(r'[a-z0-9]+(?:-[a-z0-9]+)*', name), f'Invalid id: {name}')
        require(name not in seen, f'Duplicate id: {name}')
        require(entry['status'] in STATUSES, f'Unknown status: {name}')
        require(bool(entry['summary'].strip()), f'Summary missing: {name}')
        dependencies = entry['depends_on']
        require(isinstance(dependencies, list) and set(dependencies) <= seen & active_ids,
                f'Missing, retired or out-of-order dependency: {name}')
        seen.add(name)
        if name in active_ids:
            expected_payloads.add(patch_path(root, entry))
            validate_checks(entry)
        else:
            require(not dependencies, f'Retired patch has dependencies: {name}')
            validate_retirement(entry, active_ids)
    payloads = set((root / 'patches').rglob('*.patch'))
    require(payloads == expected_payloads,
            f'Payloads differ from manifest. Missing: {sorted(expected_payloads - payloads)}. '
            f'Unexpected: {sorted(payloads - expected_payloads)}.')
    for path in payloads:
        require(path.is_file() and path.stat().st_size and path.resolve().is_relative_to(root.resolve()),
                f'Invalid patch payload: {path}')
    return manifest


def select(manifest, only=None):
    entries = [entry for entry in manifest['patches'] if entry['status'] in ACTIVE]
    if only is None:
        return entries
    active_ids = {entry['id'] for entry in entries}
    wanted = set(only)
    require(wanted <= active_ids, f'Unknown or retired patch ids: {sorted(wanted - active_ids)}')
    # Dependencies always precede their consumers in the manifest.
    for entry in reversed(entries):
        if entry['id'] in wanted:
            wanted.update(entry['depends_on'])
    return [entry for entry in entries if entry['id'] in wanted]


def checkout(target):
    target = target.resolve()
    top = Path(git_text(target, 'rev-parse', '--show-toplevel')).resolve()
    require(top == target, '--target must name the SDK checkout root')
    return target


def status(target):
    return git(target, 'status', '--porcelain', '--untracked-files=all', '--ignore-submodules=none')


def clean_base(target, base):
    require(not status(target), f'Target has changes or untracked files: {target}. Use a clean checkout.')
    head = git_text(target, 'rev-parse', 'HEAD')
    require(head == base, f'Target HEAD {head} differs from fixed upstream {base}')


def check_upstream_replacements(target, manifest):
    for entry in manifest['patches']:
        if entry['status'] != 'upstream':
            continue
        commit = entry['replacement']['commit']
        try:
            git(target, 'merge-base', '--is-ancestor', commit, manifest['upstream']['commit'])
        except Failure as error:
            raise Failure(f'{entry["id"]}: cannot verify upstream replacement {commit}') from error


def prepare(root, target, manifest, entries):
    base = manifest['upstream']['commit']
    clean_base(target, base)
    check_upstream_replacements(target, manifest)
    # Preflight the entire sequence with a private index. A later conflict cannot
    # leave earlier patches in the user's index or working tree.
    with tempfile.TemporaryDirectory(prefix='agents-patchset-') as temporary:
        env = {**os.environ, 'GIT_INDEX_FILE': str(Path(temporary) / 'index')}
        git(target, 'read-tree', base, env=env)
        for entry in entries:
            try:
                git(target, 'apply', '--cached', '--binary', '--whitespace=nowarn',
                    str(patch_path(root, entry).resolve()), env=env)
            except Failure as error:
                raise Failure(f'Preflight stopped at {entry["id"]}. Target unchanged.\n{error}') from error
        tree = git_text(target, 'write-tree', env=env)
    return tree, binary_diff(target, base, tree)


def apply(root, target, manifest, entries, write=False):
    tree, combined = prepare(root, target, manifest, entries)
    if write and combined:
        clean_base(target, manifest['upstream']['commit'])
        git(target, 'apply', '--index', '--binary', '--whitespace=nowarn', '-', data=combined)
    action = 'APPLIED (staged)' if write else 'CHECKED'
    print(f'{action} {", ".join(entry["id"] for entry in entries) or "(empty)"}\ntree {tree}', flush=True)
    return tree


def run_jest(target, paths):
    for path in paths:
        require((target / path).is_file(), f'Jest file missing in SDK checkout: {path}')
    with tempfile.TemporaryDirectory(prefix='agents-jest-') as temporary:
        report = Path(temporary) / 'result.json'
        subprocess.run(['npm', 'test', '--', '--runInBand', '--runTestsByPath', *paths,
                        '--json', f'--outputFile={report}'], cwd=target, check=True,
                       env={**os.environ, 'NODE_ENV': 'test'})
        results = read_json(report)['testResults']
        executed = {Path(result['name']).resolve() for result in results
                    if any(test['status'] == 'passed' for test in result['assertionResults'])}
        missing = sorted(set((target / path).resolve() for path in paths) - executed)
        require(not missing, f'No passing Jest test in requested suite(s): {missing}')


def test(target, entries, plan=False):
    jest = list(dict.fromkeys(path for entry in entries for path in entry.get('jest', [])))
    commands = list(dict.fromkeys(tuple(command) for entry in entries for command in entry.get('commands', [])))
    require(jest or commands, 'No checks for this selection')
    if jest:
        print('JEST ' + ' '.join(jest), flush=True)
        if not plan:
            run_jest(target, jest)
    for command in commands:
        print('RUN ' + ' '.join(command), flush=True)
        if not plan:
            subprocess.run(command, cwd=target, check=True)


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('action', choices=('list', 'check', 'apply', 'test'))
    parser.add_argument('--target', type=Path, help='SDK checkout root')
    parser.add_argument('--only', nargs='+', metavar='ID', help='include these groups and their dependencies')
    parser.add_argument('--plan', action='store_true', help='list tests without running them')
    args = parser.parse_args()
    try:
        manifest = load_manifest()
        if args.action == 'list':
            for entry in select(manifest, args.only) if args.only else manifest['patches']:
                print(f'{entry["id"]:<24} {entry["status"]:<12} {entry["summary"]}')
            return
        require(args.target is not None, '--target is required')
        target = checkout(args.target)
        entries = select(manifest, args.only)
        if args.action == 'test':
            test(target, entries, args.plan)
        else:
            require(not args.plan, '--plan applies only to test')
            apply(ROOT, target, manifest, entries, write=args.action == 'apply')
    except (Failure, OSError, ValueError, KeyError, TypeError, subprocess.CalledProcessError) as error:
        parser.exit(1, f'error: {error}\n')


if __name__ == '__main__':
    main()
