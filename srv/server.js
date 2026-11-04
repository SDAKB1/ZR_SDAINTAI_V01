const cds = require('@sap/cds');
const express = require('express');
const path = require('path');
const fs = require('fs');

// DocumentService.parseDocument takes the file as a base64 string in the OData
// action body. CAP's default JSON body limit is too small for that (a ~15MB
// PDF becomes a ~20MB base64 string), so raise it before CAP mounts its own
// body parsers. No exported function here on purpose — see @sap/cds/bin/serve.js
// _local_server_js(): a server.js that doesn't export a function is imported
// for its side effects, then the default cds.server bootstrap still runs.
cds.on('bootstrap', (app) => {
  app.use(express.json({ limit: '25mb' }));

  // Design-request intake for the UX/UI Design Studio (btp_cockpit_UXUI.html).
  //
  // Every submission is written to a local JSON file for instant UI feedback
  // (list her own history, works even if the GitHub step below fails or isn't
  // configured), AND — the durable path — committed straight into
  // docs/ux-change-requests/ in the real GitHub repo via the Contents API, so
  // the request survives this container's next restart/redeploy without
  // needing a human to manually archive it first.
  //
  // Deliberately NOT implemented by shelling out to `git commit`/`git push`:
  // that needs the git binary and a full working copy inside this container,
  // plus a long-lived credential capable of driving git directly. A single
  // authenticated HTTPS call to GitHub's Contents API needs neither — just one
  // fine-grained Personal Access Token (Contents: Read and write, scoped to
  // this repo only) stored as the GITHUB_PAT env var on this CF app. Without
  // that env var set, this step is skipped and the request still saves locally
  // — the app never breaks for the requester just because git isn't wired up.
  const designRequestsFile = path.join(__dirname, '..', 'data', 'design-requests.json');
  function readDesignRequests() {
    try { return JSON.parse(fs.readFileSync(designRequestsFile, 'utf8')); } catch (e) { return []; }
  }
  function writeDesignRequests(list) {
    fs.mkdirSync(path.dirname(designRequestsFile), { recursive: true });
    fs.writeFileSync(designRequestsFile, JSON.stringify(list, null, 2));
  }
  function buildDesignRequestMarkdown(entry) {
    return `# UX Change Request — ${entry.id}\n\n` +
      `- **Requester:** ${entry.requester}\n` +
      `- **Submitted:** ${entry.submittedAt} (via btp_cockpit_UXUI.html)\n` +
      `- **Status:** Pending Review\n\n` +
      `## Request\n\n> ${entry.message.replace(/\n/g, '\n> ')}\n\n` +
      `## SDA Analysis\n\n_Pending — run CHECKUX to analyze and propose a solution._\n\n` +
      `## Decision\n\n- [ ] Approved by Ayman\n- [ ] Rejected by Ayman\n- [ ] Needs clarification from the requester\n`;
  }
  async function commitDesignRequestToGitHub(entry) {
    const token = process.env.GITHUB_PAT;
    if (!token) throw new Error('GITHUB_PAT not configured — saved locally only, not committed to git');
    const owner = process.env.GITHUB_REPO_OWNER || 'SDAKB1';
    const repo = process.env.GITHUB_REPO_NAME || 'SDAINTAI';
    const branch = process.env.GITHUB_REPO_BRANCH || 'main';
    const dateStr = entry.submittedAt.slice(0, 10);
    const filePath = `docs/ux-change-requests/${dateStr}-${entry.id}.md`;
    const content = buildDesignRequestMarkdown(entry);

    const res = await fetch(`https://api.github.com/repos/${owner}/${repo}/contents/${encodeURIComponent(filePath)}`, {
      method: 'PUT',
      headers: {
        Authorization: `Bearer ${token}`,
        Accept: 'application/vnd.github+json',
        'Content-Type': 'application/json',
        'User-Agent': 'sdaintai-design-studio'
      },
      body: JSON.stringify({
        message: `UX change request ${entry.id} from ${entry.requester}: ${entry.message.slice(0, 72)}`,
        content: Buffer.from(content, 'utf8').toString('base64'),
        branch
      })
    });
    if (!res.ok) {
      const errText = await res.text();
      throw new Error(`GitHub API ${res.status}: ${errText.slice(0, 300)}`);
    }
  }
  app.post('/api/design-requests', async (req, res) => {
    const message = String((req.body && req.body.message) || '').trim();
    if (!message) return res.status(400).json({ error: 'message is required' });
    const requester = String((req.body && req.body.requester) || 'UX Reviewer').trim().slice(0, 80);
    const entry = {
      id: Date.now().toString(36) + Math.random().toString(36).slice(2, 6),
      requester, message: message.slice(0, 4000),
      submittedAt: new Date().toISOString(), status: 'submitted',
      gitCommitted: false, gitError: null
    };
    try {
      await commitDesignRequestToGitHub(entry);
      entry.gitCommitted = true;
    } catch (e) {
      entry.gitError = e.message;
      console.error('[design-requests] GitHub commit skipped/failed:', e.message);
    }
    const list = readDesignRequests();
    list.push(entry);
    writeDesignRequests(list);
    res.status(201).json(entry);
  });
  app.get('/api/design-requests', (req, res) => {
    res.json(readDesignRequests());
  });

  // Serves the aiconx frontend (btp_cockpit.html etc.) from this same app/origin,
  // so its relative fetch('/odata/v4/documents/...') calls reach this backend
  // instead of 404ing against a separate static-only host.
  app.use(express.static(path.join(__dirname, '..', 'app', 'aiconx', 'webapp')));
});
