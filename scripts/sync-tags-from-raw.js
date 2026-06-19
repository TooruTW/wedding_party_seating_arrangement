#!/usr/bin/env node
/**
 * Merge guests.raw.json → guests.tags.json
 * - Infers form relationship_id from raw.relationship; preserves manual tags
 * - Validates relationship_ids against data/tags.json (unknown → warn)
 * - Tagging pending: empty or only form-derived ids (first four in tags.json)
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

/** Form dropdown only yields these four; ignored when checking manual tagging pending */
const FORM_RELATIONSHIP_IDS = new Set([
  'groom_family',
  'bride_family',
  'groom_friends',
  'bride_friends',
]);

const RELATIONSHIP_TEXT_TO_ID = {
  男方家人: 'groom_family',
  男方家族: 'groom_family',
  女方家人: 'bride_family',
  女方家族: 'bride_family',
  男方朋友: 'groom_friends',
  女方朋友: 'bride_friends',
};

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

function inferFormRelationshipId(rawRow) {
  const text = String(rawRow?.relationship ?? '').trim();
  return RELATIONSHIP_TEXT_TO_ID[text] ?? null;
}

function splitRelationshipIds(relationshipIds) {
  const manual = [];
  for (const id of Array.isArray(relationshipIds) ? relationshipIds : []) {
    if (FORM_RELATIONSHIP_IDS.has(id)) continue;
    manual.push(id);
  }
  return manual;
}

function buildRelationshipIds(rawRow, existingIds) {
  const manual = splitRelationshipIds(existingIds);
  const formId = inferFormRelationshipId(rawRow);
  return formId ? [formId, ...manual] : manual;
}

function isTaggingPending(relationshipIds) {
  return splitRelationshipIds(relationshipIds).length === 0;
}

function validateRelationshipIds(relationshipIds, validIds) {
  const ids = Array.isArray(relationshipIds) ? relationshipIds : [];
  const seen = new Set();
  const deduped = [];
  const errors = [];
  for (const id of ids) {
    if (seen.has(id)) continue;
    seen.add(id);
    if (!validIds.has(id)) {
      errors.push(['wrong_id', id]);
    }
    deduped.push(id);
  }
  if (isTaggingPending(deduped)) {
    errors.push(['empty']);
  }
  return { deduped, errors };
}

function mergeInvalidByPhone(invalidByPhone, phone, errors) {
  if (!errors.length) return;
  const prev = invalidByPhone.get(phone) ?? [];
  invalidByPhone.set(phone, [...prev, ...errors]);
}

function invalidListFromMap(invalidByPhone) {
  return [...invalidByPhone.entries()]
    .sort(([a], [b]) => a.localeCompare(b))
    .map(([phone, error]) => ({ phone, error }));
}

function computeSummary(lists, pendingList, invalidList) {
  const active = lists.filter((row) => !row.removed_from_raw);
  let total_attendee_count = 0;
  let total_baby_count = 0;
  let total_vegetarian_count = 0;
  for (const row of active) {
    total_attendee_count += Number(row.total_attendee_count) || 0;
    total_baby_count += Number(row.baby_count) || 0;
    total_vegetarian_count += Number(row.vegetarian_count) || 0;
  }
  const removed_count = lists.length - active.length;
  return {
    total_attendee_count,
    total_baby_count,
    total_vegetarian_count,
    party_count: active.length,
    removed_count,
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
    pending: [],
  };

  const invalidByPhone = new Map();

  const mergedByPhone = new Map();
  const pendingPhones = [];

  for (const [phone, rawRow] of rawByPhone) {
    const existing = existingByPhone.get(phone);
    const fields = pickRawFields(rawRow);
    const isNew = !existing;
    const formUpdated =
      !!existing && existing.form_submitted_at !== fields.form_submitted_at;

    const { deduped, errors } = validateRelationshipIds(
      buildRelationshipIds(rawRow, existing?.relationship_ids),
      validIds,
    );
    mergeInvalidByPhone(invalidByPhone, phone, errors);

    const entry = {
      ...(existing ?? {}),
      ...fields,
      relationship_ids: deduped,
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
    const { deduped, errors } = validateRelationshipIds(
      existing.relationship_ids,
      validIds,
    );
    mergeInvalidByPhone(invalidByPhone, phone, errors);

    const entry = {
      ...existing,
      relationship_ids: deduped,
      removed_from_raw: true,
    };
    report.stale.push(phone);
    mergedByPhone.set(phone, entry);
  }

  const lists = [...mergedByPhone.values()].sort((a, b) =>
    a.phone.localeCompare(b.phone),
  );
  const taggingPendingPhones = lists
    .filter((row) => !row.removed_from_raw && isTaggingPending(row.relationship_ids))
    .map((row) => row.phone);
  const pendingList = [...new Set([...pendingPhones, ...taggingPendingPhones])]
    .filter((phone) => {
      const row = mergedByPhone.get(phone);
      return row && !row.removed_from_raw;
    })
    .sort();
  report.pending = pendingList;

  const removedPhones = new Set(
    lists.filter((row) => row.removed_from_raw).map((row) => row.phone),
  );
  const invalidList = invalidListFromMap(invalidByPhone).filter(
    (row) => !removedPhones.has(row.phone),
  );
  const summary = computeSummary(lists, pendingList, invalidList);
  const result = { summary, lists };

  return { result, report, invalidList };
}

function printReport(report, summary, invalidList) {
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
  if (invalidList.length) {
    for (const { phone, error } of invalidList) {
      for (const item of error) {
        if (item[0] === 'empty') {
          console.log(`  warn:    ${phone} tagging pending (no manual relationship_ids)`);
        } else if (item[0] === 'wrong_id') {
          console.log(`  warn:    ${phone} invalid relationship_id "${item[1]}"`);
        }
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
  const { result, report, invalidList } = syncTagsFromRaw();
  printReport(report, result.summary, invalidList);

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
  // ponytail: smoke check for relationship inference + pending rules
  const assert = (cond, msg) => {
    if (!cond) throw new Error(`self-check: ${msg}`);
  };
  assert(inferFormRelationshipId({ relationship: '男方家人' }) === 'groom_family');
  assert(
    buildRelationshipIds(
      { relationship: '女方朋友' },
      ['bride_friends', 'bride_taipei_friends'],
    ).join() === 'bride_friends,bride_taipei_friends',
  );
  assert(isTaggingPending(['groom_family']));
  assert(!isTaggingPending(['groom_family', 'groom_paternal_relatives']));
  const bad = validateRelationshipIds(['groom_family', 'nope'], new Set(['groom_family']));
  assert(bad.errors.some((e) => e[0] === 'wrong_id' && e[1] === 'nope'));
  assert(validateRelationshipIds(['groom_family'], new Set(['groom_family'])).errors[0][0] === 'empty');

  try {
    main();
  } catch (err) {
    console.error(`error: ${err.message}`);
    process.exit(1);
  }
}

module.exports = {
  syncTagsFromRaw,
  computeSummary,
  dedupeRaw,
  inferFormRelationshipId,
  buildRelationshipIds,
  isTaggingPending,
  validateRelationshipIds,
  mergeInvalidByPhone,
  invalidListFromMap,
};
