#!/usr/bin/env node
/**
 * 從 n8n-data/database.sqlite 匯出 workflow 到 n8n/workflows/
 * 用法：node scripts/export-n8n-workflows.js
 */
const fs = require('fs');
const path = require('path');
const { DatabaseSync } = require('node:sqlite');

const ROOT = path.join(__dirname, '..');
const DB = path.join(ROOT, 'n8n-data', 'database.sqlite');
const OUT_DIR = path.join(ROOT, 'n8n', 'workflows');

const PLACEHOLDER_SHEET_ID = 'YOUR_GOOGLE_SHEET_ID';

function sanitizeWorkflow(wf) {
  for (const node of wf.nodes) {
    if (node.type === 'n8n-nodes-base.googleSheets' && node.parameters?.documentId) {
      node.parameters.documentId = {
        __rl: true,
        value: PLACEHOLDER_SHEET_ID,
        mode: 'id',
      };
      node.parameters.sheetName = {
        __rl: true,
        value: '表單回應 1',
        mode: 'name',
      };
    }
    if (node.credentials) {
      for (const cred of Object.values(node.credentials)) {
        delete cred.id;
      }
    }
  }
  delete wf.versionId;
  if (wf.meta) wf.meta = {};
  return wf;
}

if (!fs.existsSync(DB)) {
  console.error('找不到', DB, '— 請先 docker compose up 並在 n8n 建立 workflow');
  process.exit(1);
}

const db = new DatabaseSync(DB);
const rows = db.prepare('SELECT name, nodes, connections, pinData, settings, staticData, meta FROM workflow_entity').all();

fs.mkdirSync(OUT_DIR, { recursive: true });

for (const row of rows) {
  const wf = sanitizeWorkflow({
    name: row.name,
    nodes: JSON.parse(row.nodes),
    connections: JSON.parse(row.connections),
    pinData: row.pinData ? JSON.parse(row.pinData) : {},
    settings: row.settings ? JSON.parse(row.settings) : {},
    staticData: row.staticData ? JSON.parse(row.staticData) : null,
    meta: row.meta ? JSON.parse(row.meta) : {},
  });
  const out = path.join(OUT_DIR, `${row.name}.json`);
  fs.writeFileSync(out, JSON.stringify(wf, null, 2) + '\n');
  console.log('exported', out);
}
