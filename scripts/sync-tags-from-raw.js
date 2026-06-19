#!/usr/bin/env node
/**
 * Merge guests.raw.json → guests.tags.json
 * - Preserves relationship_ids; syncs form fields from raw
 * - Validates relationship_ids against data/tags.json (empty or unknown → warn)
 * - Recomputes summary + pending_list + invalid_list; use --validate to print & write
 */
const fs = require('fs');
const path = require('path');

const ROOT = path.join(__dirname, '..');
const RAW_PATH = path.join(ROOT, 'data', 'guests.raw.json');
const TAGS_MASTER_PATH = path.join(ROOT, 'data', 'tags.json');
const TAGS_PATH = path.join(ROOT, 'data', 'guests.tags.json');
const BACKUP_PATH = path.join(ROOT, 'data', 'guests.tags.backup.json');

const RAW_FIELDS = [
  'phone',
  'name',
  'invitation_type',
  'mail_address',
  'email_address',
  'total_attendee_count',
  'baby_count',
  'vegetarian_count',
  'form_submitted_at',
];

const args = new Set(process.argv.slice(2));
const validate = args.has('--validate');
const pendingOnly = args.has('--pending');

function readJson(filePath, label) {
  if (!fs.existsSync(filePath)) {
    if (label === 'guests.tags.json') return { summary: {}, lists: [] };
    throw new Error(`${label} not found: ${filePath}`);
  }
  try {
    return JSON.parse(fs.readFileSync(filePath, 'utf8'));
  } catch (err) {
    throw new Error(`${label} invalid JSON: ${err.message}`);
  }
}

/** ponytail: duplicate phone → last row in raw array wins (sheet appends newer rows) */
function dedupeRaw(rows) {
  const byPhone = new Map();
  for (const row of rows) {
    const phone = String(row.phone ?? '').trim();
    if (!phone) continue;
    byPhone.set(phone, row);
  }
  return byPhone;
}

function pickRawFields(row) {
  const out = {};
  for (const key of RAW_FIELDS) {
    out[key] = row[key] ?? (key === 'invitation_type' ? [] : key.includes('count') ? 0 : '');
  }
  out.phone = String(out.phone).trim();
  return out;
}

function loadValidRelationshipIds(tagsMaster) {
  if (!Array.isArray(tagsMaster)) throw new Error('tags.json must be an array');
  return new Set(tagsMaster.map((t) => t.relationship_id).filter(Boolean));
}

function validateRelationshipIds(relationshipIds, validIds, phone, report) {
  const ids = Array.isArray(relationshipIds) ? relationshipIds : [];
  const seen = new Set();
  const deduped = [];
  for (const id of ids) {
    if (seen.has(id)) continue;
    seen.add(id);
    if (!validIds.has(id)) {
      report.invalid.push({ phone, id });
    }
    deduped.push(id);
  }
  if (deduped.length === 0) {
    report.invalid.push({ phone, id: null });
  }
  return deduped;
}

function computeSummary(lists, pendingList, invalidList) {
  let total_attendee_count = 0;
  let total_baby_count = 0;
  let total_vegetarian_count = 0;
  for (const row of lists) {
    total_attendee_count += Number(row.total_attendee_count) || 0;
    total_baby_count += Number(row.baby_count) || 0;
    total_vegetarian_count += Number(row.vegetarian_count) || 0;
  }
  return {
    total_attendee_count,
    total_baby_count,
    total_vegetarian_count,
    party_count: lists.length,
    pending_count: pendingList.length,
    pending_list: pendingList,
    invalid_count: invalidList.length,
    invalid_list: invalidList,
  };
}

function fieldEqual(a, b) {
  if (a === b) return true;
  if (typeof a === 'object' || typeof b === 'object') {
    return JSON.stringify(a) === JSON.stringify(b);
  }
  return false;
}

function syncTagsFromRaw() {
  const rawRows = readJson(RAW_PATH, 'guests.raw.json');
  if (!Array.isArray(rawRows)) throw new Error('guests.raw.json must be an array');

  const tagsMaster = readJson(TAGS_MASTER_PATH, 'tags.json');
  const validIds = loadValidRelationshipIds(tagsMaster);
  const tagsDoc = readJson(TAGS_PATH, 'guests.tags.json');
  const existingLists = Array.isArray(tagsDoc.lists) ? tagsDoc.lists : [];
  const existingByPhone = new Map(existingLists.map((row) => [row.phone, row]));

  const rawByPhone = dedupeRaw(rawRows);
  const rawPhones = new Set(rawByPhone.keys());

  const report = {
    added: [],
    updated: [],
    stale: [],
    invalid: [],
    pending: [],
  };

  const mergedByPhone = new Map();
  const pendingPhones = [];

  for (const [phone, rawRow] of rawByPhone) {
    const existing = existingByPhone.get(phone);
    const fields = pickRawFields(rawRow);
    const isNew = !existing;
    const formUpdated =
      !!existing && existing.form_submitted_at !== fields.form_submitted_at;

    const entry = {
      ...(existing ?? {}),
      ...fields,
      relationship_ids: validateRelationshipIds(
        existing?.relationship_ids ?? [],
        validIds,
        phone,
        report,
      ),
      removed_from_raw: false,
    };

    if (isNew) {
      report.added.push(phone);
      pendingPhones.push(phone);
    } else {
      if (formUpdated) {
        report.updated.push({
          phone,
          from: existing.form_submitted_at,
          to: fields.form_submitted_at,
        });
        pendingPhones.push(phone);
      }
      const changedFields = RAW_FIELDS.filter(
        (k) => k !== 'phone' && !fieldEqual(existing[k], entry[k]),
      );
      if (changedFields.length && !formUpdated) {
        report.updated.push({ phone, fields: changedFields });
      }
    }

    mergedByPhone.set(phone, entry);
  }

  for (const [phone, existing] of existingByPhone) {
    if (rawPhones.has(phone)) continue;
    const entry = {
      ...existing,
      relationship_ids: validateRelationshipIds(
        existing.relationship_ids,
        validIds,
        phone,
        report,
      ),
      removed_from_raw: true,
    };
    report.stale.push(phone);
    mergedByPhone.set(phone, entry);
  }

  const lists = [...mergedByPhone.values()].sort((a, b) =>
    a.phone.localeCompare(b.phone),
  );
  const pendingList = [...new Set(pendingPhones)].sort();
  report.pending = pendingList;

  const summary = computeSummary(lists, pendingList, report.invalid);
  const result = { summary, lists };

  return { result, report };
}

function printReport(report, summary) {
  console.log('sync-tags-from-raw');
  if (report.added.length) console.log(`  added:   ${report.added.join(', ')}`);
  else console.log('  added:   0');
  if (report.updated.length) {
    for (const u of report.updated) {
      if (u.from !== undefined) {
        console.log(`  updated: ${u.phone} (form_submitted_at changed)`);
      } else {
        console.log(`  updated: ${u.phone} (${u.fields.join(', ')})`);
      }
    }
  } else console.log('  updated: 0');
  if (report.stale.length) console.log(`  stale:   ${report.stale.join(', ')} (removed_from_raw)`);
  else console.log('  stale:   0');
  if (report.invalid.length) {
    for (const { phone, id } of report.invalid) {
      if (id == null) {
        console.log(`  warn:    ${phone} empty relationship_ids`);
      } else {
        console.log(`  warn:    ${phone} invalid relationship_id "${id}"`);
      }
    }
  }
  console.log(
    `  pending: ${report.pending.length ? report.pending.join(', ') : '0'}`,
  );
  console.log(
    `  summary: ${summary.total_attendee_count} 人 / ${summary.total_baby_count} 嬰兒 / ${summary.total_vegetarian_count} 素食 / ${summary.party_count} party`,
  );
}

function writeResult(result) {
  if (fs.existsSync(TAGS_PATH)) {
    fs.copyFileSync(TAGS_PATH, BACKUP_PATH);
  }
  fs.writeFileSync(TAGS_PATH, JSON.stringify(result, null, 2) + '\n', 'utf8');
  console.log(`\nwritten: ${TAGS_PATH}`);
}

function main() {
  const { result, report } = syncTagsFromRaw();
  printReport(report, result.summary);

  if (pendingOnly) {
    console.log('\npending_list:', JSON.stringify(result.summary.pending_list));
    return;
  }

  if (validate) {
    console.log('\ninvalid_list:', JSON.stringify(result.summary.invalid_list));
    writeResult(result);
    return;
  }

  writeResult(result);
}

if (require.main === module) {
  try {
    main();
  } catch (err) {
    console.error(`error: ${err.message}`);
    process.exit(1);
  }
}

module.exports = { syncTagsFromRaw, computeSummary, dedupeRaw };
