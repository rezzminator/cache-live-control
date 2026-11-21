import { expect, test } from 'vitest';
import { spawnSync } from 'node:child_process';
import { copyFileSync, mkdtempSync, mkdirSync, writeFileSync, rmSync, chmodSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath, URL } from 'node:url';
const root = fileURLToPath(new URL('../../', import.meta.url));
test('candidate scan distinguishes safe files, leaked paths, and failed enumeration', () => {
  const dir = mkdtempSync(join(tmpdir(), 'keepwarm-scan-'));
  const run = () => spawnSync(process.execPath, [join(root, 'scripts/keepwarm-check-structure.mjs'), '--root', dir], { encoding: 'utf8' });
  try {
    writeFileSync(join(dir, 'ok.txt'), 'safe\n');
    expect(run().status).toBe(0);
    writeFileSync(join(dir, 'bad.txt'), '/' + 'home' + '/example/private');
    expect(run().stdout + run().stderr).toContain('LEAK bad.txt');
    mkdirSync(join(dir, 'plugins/cache-live-control/.opencode'), { recursive: true });
    writeFileSync(join(dir, 'plugins/cache-live-control/.opencode/private.txt'), '/' + 'home' + '/example/private');
    expect(run().stdout + run().stderr).toContain('LEAK plugins/cache-live-control/.opencode/private.txt');
    rmSync(dir, { recursive: true });
    expect(run().stdout + run().stderr).toContain('ERROR enumerate');
  } finally { rmSync(dir, { recursive: true, force: true }); }
});
test('release check verifies all public versions and names mismatches', () => {
  const dir = mkdtempSync(join(tmpdir(), 'keepwarm-release-'));
  const run = (...base: string[]) => spawnSync('/bin/bash', [join(dir, 'scripts/release-check.sh'), ...base], { encoding: 'utf8' });
  try {
    mkdirSync(join(dir, 'plugins/cache-live-control/.claude-plugin'), { recursive: true }); mkdirSync(join(dir, 'scripts')); mkdirSync(join(dir, '.github/workflows'), { recursive: true });
    copyFileSync(join(root, 'scripts/release-check.sh'), join(dir, 'scripts/release-check.sh'));
    writeFileSync(join(dir, 'package.json'), JSON.stringify({ version: '0.1.0' }));
    writeFileSync(join(dir, 'plugins/cache-live-control/.claude-plugin/plugin.json'), JSON.stringify({ name: 'cache-live-control', version: '0.1.0' }));
    writeFileSync(join(dir, 'README.md'), '[![Version](https://img.shields.io/badge/version-0.1.0-blue)]\n> Claude Code 2.1.316, the version CI pins');
    writeFileSync(join(dir, '.github/workflows/ci.yml'), '  CLAUDE_CODE_VERSION: "2.1.316"\n');
    writeFileSync(join(dir, 'CHANGELOG.md'), '## [0.1.0] — 2026-10-17\nInitial.\n');
    expect(run().stdout).toBe('PASS release 0.1.0: versions agree, CHANGELOG dated\n');
    for (const base of ['0.1.0', '0.2.0']) {
      const result = run(base);
      expect(result.status).toBe(1); expect(result.stdout).toBe(`FAIL version 0.1.0 has not moved past main's ${base}\n`);
    }
    writeFileSync(join(dir, 'package.json'), JSON.stringify({ version: '0.2.0' }));
    expect(run().stdout).toBe('FAIL package.json says 0.2.0, plugin.json 0.1.0\n');
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

test('linked worktree scans staged content, not only its safe working copy', () => {
  const dir = mkdtempSync(join(tmpdir(), 'keepwarm-index-'));
  try {
    mkdirSync(join(dir, 'bin')); writeFileSync(join(dir, '.git'), 'gitdir: external'); writeFileSync(join(dir, 'candidate.txt'), 'safe');
    const git = join(dir, 'bin/git'); writeFileSync(git, '#!/bin/sh\ncase "$1 $2" in "ls-files --deleted") ;; ls-files*|diff*) printf "candidate.txt\\0";; show*) printf "' + '/' + 'home' + '/example/private";; esac\n'); chmodSync(git, 0o755);
    const result = spawnSync(process.execPath, [join(root, 'scripts/keepwarm-check-structure.mjs'), '--root', dir], { encoding: 'utf8', env: { ...process.env, PATH: join(dir, 'bin') } });
    expect(result.status).toBe(1); expect(result.stderr).toContain('LEAK staged:candidate.txt');
  } finally { rmSync(dir, { recursive: true, force: true }); }
});
test('a tracked file deleted from the working tree is no candidate, its siblings still are', () => {
  const dir = mkdtempSync(join(tmpdir(), 'keepwarm-deleted-'));
  const git = (...args: string[]) => spawnSync('git', ['-C', dir, '-c', 'user.name=t', '-c', 'user.email=t@example.com', ...args], { encoding: 'utf8' });
  try {
    expect(git('init', '-q').status).toBe(0);
    writeFileSync(join(dir, 'gone.yml'), 'safe\n'); writeFileSync(join(dir, 'kept.txt'), 'safe\n');
    expect(git('add', '.').status).toBe(0); expect(git('commit', '-qm', 'two files').status).toBe(0);
    rmSync(join(dir, 'gone.yml'));
    const result = spawnSync(process.execPath, [join(root, 'scripts/keepwarm-check-structure.mjs'), '--root', dir], { encoding: 'utf8' });
    expect([result.status, result.stderr, result.stdout]).toEqual([0, '', 'Enumerated 1 working candidates and 0 staged candidates\nPASS structure: scanned 1 candidate contents\n']);
  } finally { rmSync(dir, { recursive: true, force: true }); }
});
test('native gate prerequisites report NOT RUN when claude is missing', async () => {
  const { readFileSync } = await import('node:fs');
  const pkg = JSON.parse(readFileSync(join(root, 'package.json'), 'utf8'));
  const dir = mkdtempSync(join(tmpdir(), 'keepwarm-prereq-'));
  try { for (const name of ['test:hooks', 'validate:plugin']) {
    const result = spawnSync('/bin/sh', ['-c', pkg.scripts[name]], { encoding: 'utf8', env: { PATH: dir } });
    expect(result.status).toBe(3); expect(result.stdout).toContain('NOT RUN: missing claude');
  } } finally { rmSync(dir, { recursive: true, force: true }); }
});
