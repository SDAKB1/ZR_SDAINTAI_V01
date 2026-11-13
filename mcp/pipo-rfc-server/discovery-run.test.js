'use strict';

const assert = require('node:assert/strict');
const { test } = require('node:test');
const fs = require('node:fs/promises');
const path = require('node:path');
const os = require('node:os');
const { createHash } = require('node:crypto');
const { spawnSync } = require('node:child_process');
const { createRun } = require('./discovery-run');
const { diagnose, projectDiagnostic } = require('./discovery-diagnostics');

const clock = () => new Date('2026-11-13T09:08:07.006Z');
const sha256 = bytes => createHash('sha256').update(bytes).digest('hex');
const readJSON = async (directory, filename) => JSON.parse(await fs.readFile(path.join(directory, filename), 'utf8'));

async function temporary(t) {
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), 'pipo-discovery-run-'));
  // Remove only the exact, freshly allocated test directory.
  t.after(() => fs.rm(directory, { recursive: true, force: true }));
  return directory;
}

test('fixed UTC timestamps still create unique, exclusive run directories', async t => {
  const outputDir = await temporary(t);
  const runs = await Promise.all(Array.from({ length: 8 }, () => createRun({ outputDir, clock })));
  assert.equal(new Set(runs.map(run => run.runId)).size, runs.length);
  for (const run of runs) {
    assert.match(run.runId, /^2026-11-13T09-08-07-006Z-[a-f0-9]{8}-[a-f0-9]{4}-4[a-f0-9]{3}-[89ab][a-f0-9]{3}-[a-f0-9]{12}$/);
    assert.equal(run.directory, path.join(outputDir, run.runId));
    assert.equal(await fs.readFile(path.join(run.directory, 'events.jsonl'), 'utf8'), '');
  }
  assert.equal((await fs.readdir(outputDir)).length, runs.length);
});

test('finish drains event writes and inventories the SHA256 of exact UTF8 bytes', async t => {
  const run = await createRun({ outputDir: await temporary(t), clock });
  const eventWrites = Array.from({ length: 6 }, (_, index) => run.event({ event: 'read-start',
    phase: 'read', tool: 'fetch_pi8_repository_read_ext', status: 'started', counts: { attempted: index } }));
  const definition = { category: 'Directory', type: 'CommunicationChannel', hasFullDefinition: true,
    definition: { description: 'Übertragung 日本語', channel: 'saved-only-in-files' } };
  const output = { discovery: { endpoints: [{ category: 'Directory', status: 'ok', httpStatus: 200 }] },
    export: { reads: [
      { result: { category: 'Directory', status: 'ok', errors: {}, artifacts: [definition, definition,
        { category: 'Directory', type: 'BusinessSystem', hasFullDefinition: false, definition: { partial: true } },
        { category: 'Metadata', type: 'WSDL', metadataOnly: true, definition: '<definitions/>' }], response: { body: { notESR: true } } } },
      { tool: 'fetch_pi8_repository_read_ext', result: { status: 'ok', artifacts: [],
        response: { body: { xml: '<definition>référence</definition>' } } } },
      { result: { category: 'Repository', status: 'failed', response: { body: null } } },
      { result: { category: 'Repository', status: 'ok', response: { body: '' } } }
    ] } };
  const original = JSON.stringify(output);
  const manifest = await run.finish(output);
  await Promise.all(eventWrites);
  assert.equal(JSON.stringify(output), original);
  assert.equal(manifest.status, 'completed');
  assert.equal(manifest.migrationReady, false);
  assert.equal(manifest.startedAt, clock().toISOString());
  assert.equal(manifest.finishedAt, clock().toISOString());
  assert.deepEqual(await readJSON(run.directory, 'discovery.json'), output);
  assert.deepEqual(await readJSON(run.directory, 'manifest.json'), manifest);
  assert.equal(new Set(manifest.files.map(file => file.filename)).size, manifest.files.length);
  const artifacts = manifest.files.filter(file => file.filename.startsWith('artifacts/'));
  assert.equal(artifacts.length, 3, 'identical artifacts share a file; non-ESR bodies and catalog-only records are omitted');
  assert.equal(artifacts.filter(file => file.filename.startsWith('artifacts/ESR/ReadResponse/')).length, 2);
  const channel = artifacts.find(file => file.filename.startsWith('artifacts/Directory/CommunicationChannel/'));
  assert.deepEqual(await readJSON(run.directory, channel.filename), definition);
  for (const file of manifest.files) {
    const bytes = await fs.readFile(path.join(run.directory, file.filename));
    assert.equal(file.size, bytes.length, file.filename);
    assert.equal(file.hash, sha256(bytes), file.filename);
    if (file.filename.startsWith('artifacts/')) assert.equal(path.basename(file.filename), `${file.hash}.json`);
  }
  const events = (await fs.readFile(path.join(run.directory, 'events.jsonl'), 'utf8')).trim().split('\n').map(JSON.parse);
  assert.deepEqual(events.map(entry => entry.counts.attempted), [0, 1, 2, 3, 4, 5]);
  assert.ok(events.every(entry => entry.runId === run.runId && entry.timestamp === clock().toISOString()));
  const summary = await readJSON(run.directory, 'summary.json');
  assert.deepEqual(summary.readCoverage, { total: 4, successful: 3, metadataOnly: 0, failed: 1, unavailable: 0, unknown: 0 });
  assert.equal(summary.exportedDefinitions, 2);
  assert.equal(summary.esrResponseBodies, 2);
  assert.equal(summary.migrationReady, false);
  assert.ok(summary.gaps.length > 0);
  const before = await fs.readFile(path.join(run.directory, 'manifest.json'));
  await assert.rejects(run.finish({}), /Discovery run could not be written\./);
  await assert.rejects(run.fail(), /Discovery run could not be written\./);
  await assert.rejects(run.event({}), /Discovery run could not be written\./);
  assert.deepEqual(await fs.readFile(path.join(run.directory, 'manifest.json')), before);
});

test('HTML escapes upstream text, embeds charts, and links only generated relative files', async t => {
  const run = await createRun({ outputDir: await temporary(t), clock });
  const manifest = await run.finish({ migrationReady: true,
    discovery: { endpoints: [{ category: 'ESR', tool: 'fetch_pi8_repository_read_ext', status: 'failed',
      diagnostic: { code: 'TIMEOUT', message: '<script>diagnostic()</script>' },
      url: 'https://private.invalid/read?identifier=private' }] },
    export: { gaps: ['<script>alert("gap")</script> & \'quoted\' https://private.invalid/source',
      { tool: 'fetch_pi8_repository_read_ext', code: 'INCOMPLETE', detail: '<script>gapObject()</script>' }], reads: [
      { result: { category: '../../outside', type: '../../outside', status: 'metadata-only', artifacts: [
        { category: '../../outside', type: '../../outside', definition: { text: '<script>payload()</script>' } }
      ] } }
    ] } });
  const html = await fs.readFile(path.join(run.directory, 'report.html'), 'utf8');
  assert.match(html, /&lt;script&gt;alert\(&quot;gap&quot;\)&lt;\/script&gt; &amp; &#39;quoted&#39;/);
  assert.match(html, /&quot;code&quot;:&quot;INCOMPLETE&quot;/);
  assert.match(html, /&lt;script&gt;gapObject\(\)&lt;\/script&gt;/);
  assert.doesNotMatch(html, /\[object Object\]/);
  assert.doesNotMatch(html, /<script|<iframe|<img|https?:\/\/|private\.invalid|payload\(\)|diagnostic\(\)/i);
  for (const label of ['Endpoint outcomes', 'Artifact types', 'Read coverage', 'Failure diagnostics', 'Gaps', 'migrationReady=false', 'UNAVAILABLE']) {
    assert.ok(html.includes(label), label);
  }
  assert.equal((html.match(/<svg /g) || []).length, 3);
  assert.match(html, /<style>/);
  const generated = new Set([...manifest.files.map(file => file.filename), 'manifest.json']);
  for (const [, link] of html.matchAll(/href="([^"]+)"/g)) {
    assert.ok(generated.has(link), link);
    assert.ok(!link.includes('..') && !link.includes(':') && !link.startsWith('/'), link);
    await fs.access(path.join(run.directory, link));
  }
  assert.ok(!manifest.files.some(file => file.filename.startsWith('artifacts/Other/Other/')),
    'unverified metadata must never be saved as a full definition');
});

test('module event projection keeps stdout clean, respects levels, and leaves the CAP factory unchanged', async t => {
  const outputDir = await temporary(t);
  const script = `
    const { createRun } = require(process.argv[1]);
    const cds = require(require.resolve('@sap/cds', { paths: [process.argv[1]] }));
    const assert = require('node:assert/strict');
    (async () => {
      const logger = cds.log('pipo-discovery', 'info');
      const factory = cds.log.Logger, format = cds.log.format, loggers = cds.log.loggers;
      const run = await createRun({ outputDir: process.argv[2], env: { password: 'UPSTREAM_PRIVATE_MARKER' },
        clock: () => new Date('2026-11-13T09:08:07.006Z') });
      const marker = 'UPSTREAM_PRIVATE_MARKER';
      await run.event({ event: 'read-finish', phase: 'read', tool: 'fetch_pi8_repository_read_ext', status: 'failed',
        httpStatus: 401, durationMs: 1.5, counts: { total: 3, failed: 1, password: marker, reads: -1 },
        diagnostic: { code: 'UNAUTHORIZED', retryable: false, reason: marker, remediation: marker,
          message: marker, body: marker, url: marker },
        timestamp: marker, runId: marker, payload: marker, identifiers: [marker] });
      await run.event({ event: marker, phase: marker, tool: marker, status: marker, httpStatus: 999,
        durationMs: Infinity, counts: { total: marker, failed: -1, reads: 1.2 }, diagnostic: { code: marker, message: marker } });
      assert.equal(cds.log('pipo-discovery'), logger);
      assert.equal(cds.log.Logger, factory);
      assert.equal(cds.log.format, format);
      assert.equal(cds.log.loggers, loggers);
      assert.equal(Object.getOwnPropertyDescriptor(logger, 'info').writable, true);
      cds.log('pipo-discovery', 'silent');
      await run.event({ event: 'read-finish', phase: 'read', tool: 'fetch_pi8_repository_read_ext',
        status: 'ok', counts: { total: 71 } });
      await run.fail(new Error(marker));
    })().catch(() => { process.exitCode = 1; });
  `;
  const child = spawnSync(process.execPath, ['-e', script, require.resolve('./discovery-run'), outputDir], {
    encoding: 'utf8', timeout: 15000, windowsHide: true
  });
  assert.equal(child.error, undefined);
  assert.equal(child.status, 0, 'logging child exited successfully');
  assert.equal(child.stdout, '', 'no CAP logging on stdout');
  assert.doesNotMatch(child.stderr, /UPSTREAM_PRIVATE_MARKER|"payload"|"identifiers"|"password"|"message"|"url"|"body"|"total":71/);
  assert.match(child.stderr, /\[pipo-discovery\]/);
  const [runId] = await fs.readdir(outputDir);
  const lines = (await fs.readFile(path.join(outputDir, runId, 'events.jsonl'), 'utf8')).trim().split('\n');
  assert.equal(lines.length, 3);
  const first = JSON.parse(lines[0]);
  assert.deepEqual(first, { timestamp: clock().toISOString(), runId, event: 'read-finish', phase: 'read',
    tool: 'fetch_pi8_repository_read_ext', status: 'failed', httpStatus: 401, durationMs: 1.5,
    counts: { total: 3, failed: 1 }, diagnostic: { ...projectDiagnostic({ code: 'AUTH_REQUIRED' }), retryable: false } });
  assert.deepEqual(JSON.parse(lines[1]), { timestamp: clock().toISOString(), runId, event: 'unknown', phase: 'unknown',
    tool: 'unknown', status: 'unknown', counts: {}, diagnostic: projectDiagnostic({ code: 'FAILED' }) });
  assert.deepEqual(JSON.parse(lines[2]).counts, { total: 71 }, 'silent logging does not suppress the event file');
  assert.doesNotMatch(lines.join('\n'), /UPSTREAM_PRIVATE_MARKER/);
});

test('finish logs only supplied lifecycle events, retaining a fallback for direct callers', async t => {
  const outputDir = await temporary(t);
  const script = `
    const { createRun } = require(process.argv[1]);
    const cds = require(require.resolve('@sap/cds', { paths: [process.argv[1]] }));
    (async () => {
      cds.log('pipo-discovery', 'info');
      for (const finalEvents of [0, 1, 2]) {
        const run = await createRun({ outputDir: process.argv[2] });
        const writes = [];
        if (finalEvents) writes.push(run.event({ event: 'run-start', phase: 'discovery', status: 'started' }));
        for (let index = 0; index < finalEvents; index += 1) {
          writes.push(run.event({ event: 'run-finish', phase: 'complete', status: 'completed',
            counts: { total: 7 } }));
        }
        await run.finish({});
        await Promise.all(writes);
      }
    })().catch(() => { process.exitCode = 1; });
  `;
  const child = spawnSync(process.execPath, ['-e', script, require.resolve('./discovery-run'), outputDir], {
    encoding: 'utf8', timeout: 15000, windowsHide: true
  });
  assert.equal(child.error, undefined);
  assert.equal(child.status, 0, 'lifecycle logging child exited successfully');
  assert.equal(child.stdout, '', 'lifecycle logging stays on stderr');
  const logs = child.stderr.trim().split('\n').map(line => JSON.parse(line.replace(/^\[pipo-discovery\] /, '')));
  const runIds = await fs.readdir(outputDir);
  assert.equal(runIds.length, 3);
  const eventCounts = [];
  for (const runId of runIds) {
    const text = await fs.readFile(path.join(outputDir, runId, 'events.jsonl'), 'utf8');
    const events = text.trim().split('\n').filter(Boolean).map(JSON.parse);
    eventCounts.push(events.length);
    const runLogs = logs.filter(entry => entry.runId === runId);
    if (events.length) {
      assert.deepEqual(runLogs, events, 'finalization adds no logs and preserves repeated caller events');
      assert.equal(events[0].event, 'run-start');
      assert.ok(events.slice(1).every(entry => entry.event === 'run-finish' && entry.counts.total === 7));
    } else {
      assert.equal(runLogs.length, 1, 'creation adds no standalone start log');
      assert.equal(runLogs[0].event, 'run-finish');
      assert.deepEqual(runLogs[0].counts, { exported: 0, reads: 0 });
    }
  }
  assert.deepEqual(eventCounts.sort((a, b) => a - b), [0, 2, 3]);
});

test('fail reuses supplied CAP lifecycle diagnostics without extra logs or generic HTML failures', async t => {
  const outputDir = await temporary(t);
  const script = `
    const { createRun } = require(process.argv[1]);
    const { diagnose } = require(process.argv[3]);
    const cds = require(require.resolve('@sap/cds', { paths: [process.argv[1]] }));
    (async () => {
      cds.log('pipo-discovery', 'info');
      const marker = 'UPSTREAM_PRIVATE_MARKER';
      for (const finalEvents of [0, 1, 2]) {
        const run = await createRun({ outputDir: process.argv[2], env: { password: marker } });
        const writes = [];
        if (finalEvents) writes.push(run.event({ event: 'run-start', phase: 'discovery', status: 'started' }));
        for (let index = 0; index < finalEvents; index += 1) {
          writes.push(run.event({ event: 'run-failed', phase: 'failed', status: 'failed', httpStatus: 403,
            diagnostic: { ...diagnose(null, { status: 'failed', httpStatus: 403 }, { layer: 'cap' }),
              reason: marker, remediation: marker, message: marker }, payload: marker }));
        }
        await run.fail(new Error(marker));
        await Promise.all(writes);
      }
    })().catch(() => { process.exitCode = 1; });
  `;
  const child = spawnSync(process.execPath, ['-e', script, require.resolve('./discovery-run'), outputDir,
    require.resolve('./discovery-diagnostics')], { encoding: 'utf8', timeout: 15000, windowsHide: true });
  assert.equal(child.error, undefined);
  assert.equal(child.status, 0, 'failure logging child exited successfully');
  assert.equal(child.stdout, '', 'failure logging stays on stderr');
  const logs = child.stderr.trim().split('\n').map(line => JSON.parse(line.replace(/^\[pipo-discovery\] /, '')));
  const expected = diagnose(null, { status: 'failed', httpStatus: 403 }, { layer: 'cap' });
  const fallback = projectDiagnostic({ code: 'FAILED' });
  const runIds = await fs.readdir(outputDir);
  assert.equal(runIds.length, 3);
  const eventCounts = [];
  for (const runId of runIds) {
    const directory = path.join(outputDir, runId);
    const text = await fs.readFile(path.join(directory, 'events.jsonl'), 'utf8');
    const events = text.trim().split('\n').filter(Boolean).map(JSON.parse);
    eventCounts.push(events.length);
    const runLogs = logs.filter(entry => entry.runId === runId);
    const html = await fs.readFile(path.join(directory, 'report.html'), 'utf8');
    const manifest = await readJSON(directory, 'manifest.json');
    assert.equal(manifest.status, 'failed');
    assert.doesNotMatch(child.stderr + text + html + JSON.stringify(manifest), /UPSTREAM_PRIVATE_MARKER|Error:|stack/);
    assert.equal((html.match(/<strong>unknown: failed /g) || []).length, 1, 'HTML groups repeated failure diagnostics');
    if (events.length) {
      assert.deepEqual(runLogs, events, 'fail does not log a supplied failure a second time');
      assert.equal(events[0].event, 'run-start');
      for (const entry of events.slice(1)) {
        assert.equal(entry.event, 'run-failed');
        assert.deepEqual(entry.diagnostic, expected);
      }
      assert.match(html, /HTTP: 403; layer: cap/);
      assert.equal(html.split(expected.reason).length - 1, 1);
      assert.ok(html.includes(expected.remediation));
      assert.doesNotMatch(html, /\(FAILED\)|layer: client|Check client configuration|SAP_XI_/);
    } else {
      assert.equal(runLogs.length, 1);
      assert.equal(runLogs[0].event, 'run-failed');
      assert.deepEqual(runLogs[0].diagnostic, fallback);
      assert.match(html, /\(FAILED\).*HTTP: unknown; layer: client/);
      assert.ok(html.includes(fallback.reason));
      assert.ok(html.includes(fallback.remediation));
    }
  }
  assert.deepEqual(eventCounts.sort((a, b) => a - b), [0, 2, 3]);
});

test('fail retains accumulated safe diagnostics and remediation without serializing exceptions', async t => {
  const run = await createRun({ outputDir: await temporary(t), clock });
  const detail = diagnose('fetch_pi8_communication_channel', { status: 'failed', httpStatus: 403 },
    { roles: { PO_PJ2_DIR: [] } });
  await run.event({ event: 'endpoint-finish', phase: 'probe', tool: 'fetch_pi8_communication_channel',
    status: 'forbidden', httpStatus: 403, diagnostic: { ...detail, reason: 'UPSTREAM_PRIVATE_MARKER' } });
  const manifest = await run.fail(new Error('UPSTREAM_PRIVATE_MARKER'));
  assert.equal(manifest.status, 'failed');
  assert.equal(manifest.migrationReady, false);
  assert.equal(manifest.message, 'Discovery failed.');
  assert.deepEqual((await fs.readdir(run.directory)).sort(), ['events.jsonl', 'manifest.json', 'report.html']);
  const text = await fs.readFile(path.join(run.directory, 'manifest.json'), 'utf8');
  const html = await fs.readFile(path.join(run.directory, 'report.html'), 'utf8');
  assert.doesNotMatch(text + html, /UPSTREAM_PRIVATE_MARKER|Error:|stack/);
  assert.match(html, /status: failed/);
  assert.match(html, /migrationReady=false/);
  assert.match(html, /FORBIDDEN/);
  assert.ok(html.includes(detail.reason));
  assert.ok(html.includes(detail.remediation));
  assert.match(html, /HTTP: 403; layer: source/);
  assert.match(html, /SAP_XI_API_DISPLAY_J2EE: evidence=documented; inventory=absent/);
  assert.match(html, /\(FAILED\)/, 'the legacy RUN_FAILED code maps to the supported safe failure');
  for (const file of manifest.files) {
    const bytes = await fs.readFile(path.join(run.directory, file.filename));
    assert.equal(file.hash, sha256(bytes));
    assert.equal(file.size, bytes.length);
  }
});

test('403 events and HTML retain complete safe role diagnostics and deduplicate endpoint results', async t => {
  const run = await createRun({ outputDir: await temporary(t), clock });
  const cases = [
    { tool: 'fetch_pi8_communication_channel', roles: { PO_PJ2_DIR: [] },
      role: 'SAP_XI_API_DISPLAY_J2EE', evidence: 'documented', present: false },
    { tool: 'fetch_pi8_repository_query_ext', roles: { PO_PJ2_ESR: ['SAP_XI_DISPLAY_USER_J2EE'] },
      role: 'SAP_XI_DISPLAY_USER_J2EE', evidence: 'suggested', present: true },
    { tool: 'fetch_pi8_channel_admin', roles: {},
      role: 'SAP_XI_MONITOR_J2EE', evidence: 'suggested', present: null }
  ];
  const endpoints = [];
  for (const item of cases) {
    const detail = diagnose(item.tool, { status: 'failed', httpStatus: 403 }, { roles: item.roles });
    const endpoint = { tool: item.tool, status: 'failed', httpStatus: 403, counts: { failed: 1 },
      diagnostic: { ...detail, reason: 'UNSAFE_INPUT', remediation: 'UNSAFE_INPUT',
        roleAssessment: { ...detail.roleAssessment, effectivePermissionsVerified: true,
          candidates: [...detail.roleAssessment.candidates, { role: 'UNSAFE_INPUT', present: true }] } } };
    endpoints.push(endpoint);
    await run.event({ ...endpoint, event: 'endpoint-finish', phase: 'probe' });
    await run.event({ ...endpoint, event: 'endpoint-finish', phase: 'probe' });
  }
  await run.finish({ discovery: { endpoints } });
  const events = (await fs.readFile(path.join(run.directory, 'events.jsonl'), 'utf8')).trim().split('\n').map(JSON.parse);
  assert.equal(events.length, 6);
  for (const [index, item] of cases.entries()) {
    const detail = events[index * 2].diagnostic;
    assert.deepEqual(detail, diagnose(item.tool, { status: 'failed', httpStatus: 403 }, { roles: item.roles }));
    assert.deepEqual(detail.roleAssessment.candidates, [{ role: item.role, evidence: item.evidence, present: item.present }]);
    assert.equal(detail.layer, 'source');
    assert.equal(detail.roleAssessment.effectivePermissionsVerified, false);
  }
  const html = await fs.readFile(path.join(run.directory, 'report.html'), 'utf8');
  assert.doesNotMatch(html, /UNSAFE_INPUT/);
  for (const item of cases) {
    const presence = item.present === null ? 'unknown' : item.present ? 'present' : 'absent';
    assert.ok(html.includes(`${item.role}: evidence=${item.evidence}; inventory=${presence}`));
    assert.equal(html.split(item.role).length - 1, 1, 'duplicate events and final output share one diagnostic');
  }
  assert.equal((html.match(/<tr>/g) || []).length, 4, 'one header and one outcome row per tool');
  assert.match(html, /<th>Distinct diagnostics<\/th>/);
  assert.match(html, /<td>403<\/td><td>probe, discovery<\/td><td>endpoint-finish, endpoint-result<\/td><td>\{&quot;failed&quot;:1\}<\/td><td>1<\/td>/);
  assert.match(html, /an absent role is not a verified missing permission/);
});

test('CAP failures retain CAP remediation and never suggest source roles', async t => {
  const run = await createRun({ outputDir: await temporary(t), clock });
  const tool = 'fetch_pi8_communication_channel';
  const expected = diagnose(tool, { status: 'failed', httpStatus: 403 }, { layer: 'cap' });
  await run.event({ event: 'endpoint-finish', phase: 'probe', tool, status: 'forbidden', httpStatus: 403,
    diagnostic: { ...expected, reason: 'UNSAFE_INPUT', remediation: 'UNSAFE_INPUT',
      roleAssessment: { inventory: 'unavailable', effectivePermissionsVerified: true,
        candidates: [{ role: 'SAP_XI_API_DISPLAY_J2EE', evidence: 'documented', present: false }] } } });
  await run.finish({});
  const entry = JSON.parse((await fs.readFile(path.join(run.directory, 'events.jsonl'), 'utf8')).trim());
  assert.deepEqual(entry.diagnostic, expected);
  assert.deepEqual(entry.diagnostic.roleAssessment.candidates, []);
  const html = await fs.readFile(path.join(run.directory, 'report.html'), 'utf8');
  assert.match(html, /HTTP: 403; layer: cap/);
  assert.ok(html.includes(expected.reason));
  assert.ok(html.includes(expected.remediation));
  assert.doesNotMatch(html, /SAP_XI_|Ask the source owner|UNSAFE_INPUT/);
});

test('serialization failure is generic and can be followed by a minimal fail output', async t => {
  const run = await createRun({ outputDir: await temporary(t), clock });
  const circular = { message: 'UPSTREAM_PRIVATE_MARKER' };
  circular.circular = circular;
  await assert.rejects(run.finish(circular), error => {
    assert.equal(error.message, 'Discovery run could not be written.');
    assert.equal(error.cause, undefined);
    return true;
  });
  assert.equal((await run.fail()).status, 'failed');
  assert.doesNotMatch(await fs.readFile(path.join(run.directory, 'manifest.json'), 'utf8'), /UPSTREAM_PRIVATE_MARKER/);
});

test('existing output files are never overwritten and filesystem errors reveal no paths', async t => {
  const run = await createRun({ outputDir: await temporary(t), clock });
  const target = path.join(run.directory, 'discovery.json');
  await fs.writeFile(target, 'existing bytes', { flag: 'wx' });
  await assert.rejects(run.finish({}), error => {
    assert.equal(error.message, 'Discovery run could not be written.');
    assert.ok(!error.message.includes(run.directory));
    return true;
  });
  assert.equal(await fs.readFile(target, 'utf8'), 'existing bytes');
  const blocker = path.join(await temporary(t), 'private-path');
  await fs.writeFile(blocker, 'not a directory');
  await assert.rejects(createRun({ outputDir: blocker, clock }), { message: 'Discovery run could not be written.' });
});