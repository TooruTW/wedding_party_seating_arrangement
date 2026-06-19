#!/usr/bin/env node
/**
 * Test helper: add 1–2 random manual relationship_ids to each row in guests.tags.json.
 * Each guest keeps at most 3 relationship_ids total.
 * Picks from data/tags.json, excluding form-derived ids and ids already on the guest.
 * Usage: node scripts/randomize-guest-tags.js
 */
const fs = require('fs');
const path = require('path');

const ROOT = path.join(__dirname, '..');
const TAGS_MASTER_PATH = path.join(ROOT, 'data', 'tags.json');
const TAGS_PATH = path.join(ROOT, 'data', 'guests.tags.json');

const MAX_RELATIONSHIP_IDS = 3;

const FORM_RELATIONSHIP_IDS = new Set([
  'groom_family',
  'bride_family',
  'groom_friends',
  'bride_friends',
]);

function randInt(min, max) {
  return Math.floor(Math.random() * (max - min + 1)) + min;
}

function shuffle(arr) {
  const out = [...arr];
  for (let i = out.length - 1; i > 0; i--) {
    const j = randInt(0, i);
    [out[i], out[j]] = [out[j], out[i]];
  }
  return out;
}

function readJson(filePath, label) {
  if (!fs.existsSync(filePath)) {
    throw new Error(`${label} not found: ${filePath}`);
  }
  try {
    return JSON.parse(fs.readFileSync(filePath, 'utf8'));
  } catch (err) {
    throw new Error(`${label} invalid JSON: ${err.message}`);
  }
}

function pickExtraIds(existing, manualPool) {
  const slots = MAX_RELATIONSHIP_IDS - existing.length;
  if (slots <= 0) return [];

  const have = new Set(existing);
  const candidates = manualPool.filter((id) => !have.has(id));
  if (!candidates.length) return [];

  const count = Math.min(randInt(1, 2), candidates.length, slots);
  return shuffle(candidates).slice(0, count);
}

function main() {
  const master = readJson(TAGS_MASTER_PATH, 'tags.json');
  const data = readJson(TAGS_PATH, 'guests.tags.json');
  if (!Array.isArray(data.lists)) {
    throw new Error('guests.tags.json: lists must be an array');
  }

  const manualPool = master
    .map((row) => row.relationship_id)
    .filter((id) => id && !FORM_RELATIONSHIP_IDS.has(id));

  let added = 0;
  let skipped = 0;

  for (const row of data.lists) {
    let existing = Array.isArray(row.relationship_ids) ? [...row.relationship_ids] : [];
    if (existing.length > MAX_RELATIONSHIP_IDS) {
      existing = existing.slice(0, MAX_RELATIONSHIP_IDS);
      row.relationship_ids = existing;
    }

    const before = existing.length;
    const extra = pickExtraIds(existing, manualPool);
    if (!extra.length) {
      skipped++;
      continue;
    }
    row.relationship_ids = [...existing, ...extra];
    added += row.relationship_ids.length - before;
  }

  fs.writeFileSync(TAGS_PATH, `${JSON.stringify(data, null, 2)}\n`, 'utf8');

  const overCap = data.lists.filter(
    (row) => (row.relationship_ids?.length ?? 0) > MAX_RELATIONSHIP_IDS,
  );
  if (overCap.length) {
    throw new Error(`self-check failed: ${overCap.length} guests exceed ${MAX_RELATIONSHIP_IDS} tags`);
  }

  console.log(
    `Updated ${data.lists.length} guests (+${added} ids, ${skipped} skipped, max ${MAX_RELATIONSHIP_IDS}/guest) → ${TAGS_PATH}`,
  );
}

main();
