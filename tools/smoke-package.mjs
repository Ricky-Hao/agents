// Consume the exact npm pack output through two workspaces, as LibreChat does.
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { copyFileSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { basename, join, posix } from 'node:path';
import { fileURLToPath } from 'node:url';

const sdk = '@librechat/agents';
const workspaces = ['api', 'packages/api'];
const readJson = (file) => JSON.parse(readFileSync(file, 'utf8'));
const writeJson = (file, value) => writeFileSync(file, JSON.stringify(value, null, 2));
const workspaceDependency = (workspace, artifact) => `file:${posix.relative(workspace, artifact)}`;

async function checkConsumer(source, version, integrity, artifact) {
  const require = createRequire(import.meta.url);
  const installed = join(process.cwd(), 'node_modules', sdk);
  const pkg = readJson(join(installed, 'package.json'));
  const lock = readJson('package-lock.json');
  const key = `node_modules/${sdk}`;
  assert.deepEqual(Object.keys(lock.packages).filter((name) => name.endsWith(key)), [key]);
  assert.equal(lock.packages[key].version, version);
  assert.equal(lock.packages[key].resolved, `file:${artifact}`);
  assert.equal(lock.packages[key].integrity, integrity);
  assert.equal(pkg.name, sdk);
  assert.equal(pkg.version, version);
  assert.deepEqual(pkg.exports, readJson(join(source, 'package.json')).exports);

  const specifiers = [];
  for (const [subpath, entry] of Object.entries(pkg.exports)) {
    const specifier = subpath === '.' ? sdk : sdk + subpath.slice(1);
    assert.equal(require.resolve(specifier), join(installed, entry.require));
    assert.equal(fileURLToPath(import.meta.resolve(specifier)), join(installed, entry.import));
    assert.ok(existsSync(join(installed, entry.types)), `Missing declaration for ${specifier}`);
    require(specifier);
    await import(specifier);
    specifiers.push(specifier);
  }
  for (const workspace of workspaces) {
    assert.equal(lock.packages[workspace].dependencies[sdk], workspaceDependency(workspace, artifact));
    const consumerRequire = createRequire(join(process.cwd(), workspace, 'package.json'));
    assert.equal(consumerRequire.resolve(sdk), require.resolve(sdk));
  }
  assert.equal(typeof require(sdk).Run, 'function');
  assert.equal(typeof (await import(sdk)).Run, 'function');

  const rootTypes = `import { Run } from '${sdk}';\nconst create: typeof Run.create = Run.create;\n`;
  const entryTypes = specifiers.map((specifier, index) => `import * as entry${index} from '${specifier}';`).join('\n');
  writeFileSync('consumer.mts', `${entryTypes}\n${rootTypes}`);
  writeFileSync('consumer.cts', rootTypes);
  const tsc = [join(source, 'node_modules/typescript/bin/tsc'),
    '--noEmit', '--strict', '--skipLibCheck', '--target', 'ES2022'];
  // Match the declaration resolution modes in config/runtime-package.test.mjs.
  execFileSync(process.execPath, [...tsc, '--module', 'ESNext', '--moduleResolution', 'bundler', 'consumer.mts'],
    { stdio: 'inherit' });
  execFileSync(process.execPath, [...tsc, '--module', 'CommonJS', '--moduleResolution', 'node', 'consumer.cts'],
    { stdio: 'inherit' });
  console.log(`Tarball smoke passed: ${specifiers.length} CJS and ESM exports, bundler types and CJS root types`);
}

function installAndCheck(source, tarball, version, integrity) {
  const cwd = mkdtempSync(join(process.cwd(), 'consumer-'));
  const artifact = `vendor/${basename(tarball)}`;
  try {
    writeJson(join(cwd, 'package.json'), { name: 'agents-consumer', private: true, workspaces });
    mkdirSync(join(cwd, 'vendor'));
    copyFileSync(tarball, join(cwd, artifact));
    for (const [index, workspace] of workspaces.entries()) {
      mkdirSync(join(cwd, workspace), { recursive: true });
      writeJson(join(cwd, workspace, 'package.json'), {
        name: `agents-consumer-${index}`,
        private: true,
        dependencies: { [sdk]: workspaceDependency(workspace, artifact) },
      });
    }
    execFileSync('npm', ['install', '--ignore-scripts', '--omit=dev', '--no-audit', '--no-fund'], {
      cwd,
      stdio: 'inherit',
    });
    const runner = join(cwd, 'smoke-package.mjs');
    copyFileSync(fileURLToPath(import.meta.url), runner);
    execFileSync(process.execPath, [runner, '--installed', source, version, integrity, artifact], {
      cwd,
      stdio: 'inherit',
    });
  } finally {
    rmSync(cwd, { recursive: true, force: true });
  }
}

const args = process.argv.slice(2);
if (args[0] === '--installed') {
  await checkConsumer(...args.slice(1));
} else {
  installAndCheck(...args);
}
