'use strict';

const assert = require('node:assert/strict');
const { test } = require('node:test');
const { spawn } = require('node:child_process');
const { once } = require('node:events');
const { mkdtemp, readFile, readdir, rm } = require('node:fs/promises');
const { tmpdir } = require('node:os');
const { join } = require('node:path');
const { diagnose, projectDiagnostic } = require('./discovery-diagnostics');

async function cli(t, args, settings = {}) {
  const directory = await mkdtemp(join(tmpdir(), 'pipo-startup-'));
  t.after(() => rm(directory, { recursive: true, force: true }));
  const outputDir = join(directory, 'runs');
  const env = { ...process.env, NODE_OPTIONS: '', VSCODE_INSPECTOR_OPTIONS: '',
    PIPO_CAP_URL: '', PIPO_CAP_TOKEN: '', PIPO_CAP_USER: '', PIPO_CAP_PASS: '',
    PIPO_MCP_URL: 'not-a-network-target', PIPO_MCP_USER: 'PRIVATE_STARTUP_USER',
    PIPO_MCP_PASS: 'PRIVATE_STARTUP_PASSWORD', ...settings };
  const child = spawn(process.execPath, [require.resolve('./fetch-pipo'), ...args, `--output-dir=${outputDir}`], { env });
  let stdout = '';
  let stderr = '';
  child.stdout.on('data', chunk => { stdout += chunk; });
  child.stderr.on('data', chunk => { stderr += chunk; });
  const [code] = await once(child, 'close');
  return { directory, outputDir, code, stdout, stderr };
}

test('joined CLI flags are rejected clearly before creating a run', async t => {
  const result = await cli(t, ['--cache--export']);
  assert.equal(result.code, 1);
  assert.equal(result.stdout, '');
  assert.match(result.stderr, /INVALID_ARGUMENTS/);
  assert.match(result.stderr, /Use separate flags: --cache --export/);
  assert.doesNotMatch(result.stderr, /run-start|PRIVATE_STARTUP/);
  assert.deepEqual(await readdir(result.directory), []);
});

test('CAP startup failures report precise safe diagnostics exactly once in logs and HTML', async t => {
  const cases = [
    [{}, 'CAP_URL_MISSING', /PIPO_CAP_URL is not configured/],
    [{ PIPO_CAP_URL: 'http://127.0.0.1:1' }, 'CAP_AUTH_MISSING', /CAP authentication is not configured/],
    [{ PIPO_CAP_URL: 'https://PRIVATE_STARTUP_USER:PRIVATE_STARTUP_PASSWORD@example.invalid' },
      'CAP_URL_INVALID', /PIPO_CAP_URL is invalid/],
    [{ PIPO_CAP_URL: 'http://127.0.0.1:1', PIPO_CAP_TOKEN: 'Bearer PRIVATE_STARTUP_TOKEN' },
      'CAP_AUTH_INVALID', /CAP token format is invalid/]
  ];
  for (const [settings, expected, reason] of cases) {
    await t.test(expected, async t => {
      const result = await cli(t, ['--cache', '--export'], settings);
      assert.equal(result.code, 1);
      assert.equal(result.stdout, '');
      assert.match(result.stderr, reason);
      assert.match(result.stderr, /Run reports:/);
      const logs = result.stderr.split('\n').filter(line => line.startsWith('[pipo-discovery] '))
        .map(line => JSON.parse(line.slice('[pipo-discovery] '.length)));
      assert.deepEqual(logs.map(entry => entry.event), ['run-start', 'run-failed']);
      const failure = logs[1];
      assert.equal(failure.diagnostic.code, expected);
      assert.equal(failure.diagnostic.layer, 'cap');
      assert.deepEqual(failure.diagnostic.roleAssessment.candidates, []);
      const [runId] = await readdir(result.outputDir);
      const runDir = join(result.outputDir, runId);
      const eventsText = await readFile(join(runDir, 'events.jsonl'), 'utf8');
      assert.deepEqual(eventsText.trim().split('\n').map(JSON.parse), logs);
      const html = await readFile(join(runDir, 'report.html'), 'utf8');
      assert.match(html, reason);
      assert.match(html, /layer: cap/);
      assert.doesNotMatch(html, /layer: client/);
      const manifestText = await readFile(join(runDir, 'manifest.json'), 'utf8');
      assert.equal(JSON.parse(manifestText).status, 'failed');
      assert.doesNotMatch(result.stderr + eventsText + html + manifestText, /PRIVATE_STARTUP/);
    });
  }
});

test('local configuration diagnostics survive projection only in their proper layer', () => {
  for (const [layer, failureCode] of [['cap', 'CAP_URL_MISSING'], ['cap', 'CAP_URL_INVALID'],
    ['cap', 'CAP_AUTH_MISSING'], ['cap', 'CAP_AUTH_INVALID'], ['client', 'INVALID_ARGUMENTS']]) {
    const detail = diagnose(null, { status: 'failed', failureCode }, { layer });
    assert.equal(detail.code, failureCode);
    assert.deepEqual(projectDiagnostic({ ...detail, reason: 'PRIVATE_STARTUP', remediation: 'PRIVATE_STARTUP' }), detail);
    assert.equal(diagnose(null, { failureCode }, { layer: 'source' }).code, 'FAILED');
    assert.equal(projectDiagnostic({ ...detail, layer: 'source' }).code, 'FAILED');
    assert.equal(diagnose(null, { failureCode, httpStatus: 403 }, { layer }).code, 'FORBIDDEN');
  }
});