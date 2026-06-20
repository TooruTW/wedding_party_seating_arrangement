#!/usr/bin/env node
/**
 * Resolve groups.json pending: pack pending parties into new groups only.
 * - Does not modify existing resolved groups
 * - No relationship_ids overlap required
 * - allow_underflow_groups for wedding tail tables
 */
const fs = require('fs');
const path = require('path');
const { headTableNames, seatingHeadcount } = require('./headcount');

const ROOT = path.join(__dirname, '..');
const TAGS_PATH = path.join(ROOT, 'data', 'guests.tags.json');
const GROUPS_PATH = path.join(ROOT, 'output', 'groups.json');
const CONFIG_PATH = path.join(__dirname, 'groups-config.json');
const OVERRIDES_PATH = path.join(ROOT, 'data', 'groups-overrides.json');
const OUT_AUDIT = path.join(ROOT, 'output', 'groups.resolved-manual.json');
const OUT_PENDING = path.join(ROOT, 'output', 'groups.pending.json');

const dryRun = process.argv.includes('--dry-run');

function readJson(filePath, label) {
  try {
    return JSON.parse(fs.readFileSync(filePath, 'utf8'));
  } catch (err) {
    throw new Error(`${label} invalid JSON: ${err.message}`);
  }
}

function partySnapshot(party) {
  const names = headTableNames(party);
  return {
    phone: party.phone,
    name: party.name,
    headcount: seatingHeadcount(party),
    total_attendee_count: Number(party.total_attendee_count) || 0,
    head_table_names: [...names],
    relationship_ids: [...(party.relationship_ids ?? [])],
  };
}

function groupHeadcount(parties) {
  return parties.reduce((sum, p) => sum + seatingHeadcount(p), 0);
}

function partyByPhone(tagsDoc) {
  const map = new Map();
  for (const row of tagsDoc.lists ?? []) {
    if (row.phone) map.set(row.phone, row);
  }
  return map;
}

function loadPendingParties(pendingList, tagsDoc) {
  const byPhone = partyByPhone(tagsDoc);
  const parties = [];
  const missing = [];
  for (const item of pendingList) {
    const row = byPhone.get(item.phone);
    if (!row || row.removed_from_raw) {
      missing.push(item.phone);
      continue;
    }
    if (seatingHeadcount(row) <= 0) continue;
    parties.push(row);
  }
  if (missing.length) {
    throw new Error(`pending party not in guests.tags.json: ${missing.join(', ')}`);
  }
  return parties;
}

/** Prefer pick that reaches min; else largest that fits under max */
function pickNext(currentHc, unassigned, minPerGroup, maxPerGroup) {
  let pick = null;
  let bestScore = -Infinity;
  for (const candidate of unassigned) {
    const addHc = seatingHeadcount(candidate);
    const next = currentHc + addHc;
    if (next > maxPerGroup) continue;
    const reachesMin = next >= minPerGroup ? 1 : 0;
    const score = reachesMin * 1000 + addHc;
    if (score > bestScore) {
      bestScore = score;
      pick = candidate;
    }
  }
  return pick;
}

/** ponytail: greedy bin-pack pending only; O(n²), fine for wedding-scale n */
function packPending(parties, minPerGroup, maxPerGroup, allowUnderflow) {
  const newGroups = [];
  const stillPending = [];
  let unassigned = [...parties];

  while (unassigned.length) {
    unassigned.sort((a, b) => seatingHeadcount(b) - seatingHeadcount(a));
    const group = [unassigned[0]];
    unassigned = unassigned.filter((p) => p.phone !== group[0].phone);

    while (unassigned.length) {
      const currentHc = groupHeadcount(group);
      if (currentHc >= minPerGroup) break;
      const pick = pickNext(currentHc, unassigned, minPerGroup, maxPerGroup);
      if (!pick) break;
      group.push(pick);
      unassigned = unassigned.filter((p) => p.phone !== pick.phone);
    }

    const hc = groupHeadcount(group);
    if (hc >= minPerGroup && hc <= maxPerGroup) {
      newGroups.push({ parties: group, underflow: false });
    } else if (hc < minPerGroup && allowUnderflow) {
      newGroups.push({ parties: group, underflow: true });
    } else if (hc > maxPerGroup) {
      for (const party of group) {
        stillPending.push({
          reason: 'group_overflow',
          phone: party.phone,
          name: party.name,
          headcount: seatingHeadcount(party),
          attempted_group_headcount: hc,
          min_per_group: minPerGroup,
          max_per_group: maxPerGroup,
          needs_manual: true,
        });
      }
    } else {
      for (const party of group) {
        stillPending.push({
          reason: 'group_underflow',
          phone: party.phone,
          name: party.name,
          headcount: seatingHeadcount(party),
          attempted_group_headcount: hc,
          min_per_group: minPerGroup,
          max_per_group: maxPerGroup,
          needs_manual: true,
        });
      }
    }
  }

  return { newGroups, stillPending };
}

function applyBundles(parties, bundles) {
  const used = new Set();
  const preformed = [];
  const byPhone = new Map(parties.map((p) => [p.phone, p]));

  for (const bundle of bundles) {
    if (!Array.isArray(bundle) || !bundle.length) continue;
    const group = [];
    for (const phone of bundle) {
      if (used.has(phone)) continue;
      const party = byPhone.get(phone);
      if (!party) throw new Error(`groups-overrides bundle: unknown phone ${phone}`);
      group.push(party);
      used.add(phone);
    }
    if (group.length) preformed.push(group);
  }

  const rest = parties.filter((p) => !used.has(p.phone));
  return { preformed, rest };
}

function resolveGroupsPending(groupsDoc, tagsDoc, config, overrides) {
  const minPerGroup = Number(config.min_per_group) || 8;
  const maxPerGroup = Number(config.max_per_group) || 10;
  const allowUnderflow = config.allow_underflow_groups === true;
  if (minPerGroup > maxPerGroup) {
    throw new Error('groups-config: min_per_group cannot exceed max_per_group');
  }

  const existingGroups = Array.isArray(groupsDoc.groups) ? [...groupsDoc.groups] : [];
  const pendingList = Array.isArray(groupsDoc.pending) ? groupsDoc.pending : [];
  if (!pendingList.length) {
    return { groupsDoc, audit: { actions: [], new_groups: [], remaining_pending: [] } };
  }

  let parties = loadPendingParties(pendingList, tagsDoc);
  const bundles = overrides?.bundles ?? [];
  const { preformed, rest } = applyBundles(parties, bundles);

  const allNew = [];
  const allStillPending = [];
  const actions = [];

  for (const group of preformed) {
    const hc = groupHeadcount(group);
    const ok = (hc >= minPerGroup && hc <= maxPerGroup) || (hc < minPerGroup && allowUnderflow);
    if (ok) {
      allNew.push({ parties: group, underflow: hc < minPerGroup });
      actions.push({ type: 'bundle', phones: group.map((p) => p.phone), headcount: hc });
    } else {
      for (const party of group) {
        allStillPending.push({
          reason: hc < minPerGroup ? 'group_underflow' : 'group_overflow',
          phone: party.phone,
          name: party.name,
          headcount: seatingHeadcount(party),
          attempted_group_headcount: hc,
          min_per_group: minPerGroup,
          max_per_group: maxPerGroup,
          needs_manual: true,
        });
      }
    }
  }

  const { newGroups, stillPending } = packPending(rest, minPerGroup, maxPerGroup, allowUnderflow);
  allNew.push(...newGroups);
  allStillPending.push(...stillPending);
  for (const g of newGroups) {
    actions.push({
      type: 'packed',
      phones: g.parties.map((p) => p.phone),
      headcount: groupHeadcount(g.parties),
      underflow: g.underflow,
    });
  }

  const maxIndex = existingGroups.reduce((m, g) => Math.max(m, g.group_index ?? 0), 0);
  const appended = allNew.map((g, i) => ({
    group_index: maxIndex + i + 1,
    headcount: groupHeadcount(g.parties),
    parties: g.parties.map(partySnapshot),
    ...(g.underflow ? { underflow: true, formed_by: 'pending_resolve' } : { formed_by: 'pending_resolve' }),
  }));

  const groups = [...existingGroups, ...appended];
  const groupedHeadcount = groups.reduce((s, g) => s + g.headcount, 0);

  const result = {
    ...groupsDoc,
    summary: {
      ...(groupsDoc.summary ?? {}),
      group_count: groups.length,
      grouped_headcount: groupedHeadcount,
      pending_count: allStillPending.length,
      min_per_group: minPerGroup,
      max_per_group: maxPerGroup,
    },
    groups,
    pending: allStillPending,
  };

  const audit = {
    resolved_at: new Date().toISOString(),
    existing_group_count: existingGroups.length,
    new_groups: appended.map((g) => ({
      group_index: g.group_index,
      headcount: g.headcount,
      underflow: g.underflow ?? false,
      parties: g.parties.map((p) => p.phone),
    })),
    remaining_pending: allStillPending,
    actions,
  };

  return { groupsDoc: result, audit };
}

function printReport(audit, result) {
  console.log('resolve-groups-pending');
  console.log(`  existing groups: ${audit.existing_group_count}（未修改）`);
  console.log(`  new groups:      ${audit.new_groups.length}`);
  for (const g of audit.new_groups) {
    const flag = g.underflow ? ' [underflow]' : '';
    console.log(`    #${g.group_index} [${g.headcount}]${flag} ${g.parties.join(', ')}`);
  }
  if (result.pending.length) {
    console.log(`  still pending: ${result.pending.length}`);
    for (const p of result.pending) {
      console.log(`    ${p.phone} ${p.name}: ${p.reason}`);
    }
  } else {
    console.log('  pending: 0');
  }
}

function writeOutput(result, audit) {
  fs.mkdirSync(path.dirname(GROUPS_PATH), { recursive: true });
  fs.writeFileSync(GROUPS_PATH, JSON.stringify(result, null, 2) + '\n', 'utf8');
  fs.writeFileSync(OUT_PENDING, JSON.stringify({ pending: result.pending }, null, 2) + '\n', 'utf8');
  fs.writeFileSync(OUT_AUDIT, JSON.stringify(audit, null, 2) + '\n', 'utf8');
  console.log(`\nwritten: ${GROUPS_PATH}`);
  console.log(`written: ${OUT_PENDING}`);
  console.log(`written: ${OUT_AUDIT}`);
}

function main() {
  if (!fs.existsSync(GROUPS_PATH)) {
    throw new Error(`groups.json not found: ${GROUPS_PATH}`);
  }
  if (!fs.existsSync(TAGS_PATH)) {
    throw new Error(`guests.tags.json not found: ${TAGS_PATH}`);
  }

  const groupsDoc = readJson(GROUPS_PATH, 'groups.json');
  const tagsDoc = readJson(TAGS_PATH, 'guests.tags.json');
  const config = readJson(CONFIG_PATH, 'groups-config.json');
  const overrides = fs.existsSync(OVERRIDES_PATH)
    ? readJson(OVERRIDES_PATH, 'groups-overrides.json')
    : {};

  const { groupsDoc: result, audit } = resolveGroupsPending(groupsDoc, tagsDoc, config, overrides);
  printReport(audit, result);
  if (!dryRun) writeOutput(result, audit);
  else console.log('\n(dry-run, no files written)');
}

if (require.main === module) {
  const assert = (cond, msg) => {
    if (!cond) throw new Error(`self-check: ${msg}`);
  };
  const mk = (phone, name, hc, ids = []) => ({
    phone,
    name,
    total_attendee_count: hc,
    head_table_names: [],
    relationship_ids: ids,
    removed_from_raw: false,
  });

  const packed = packPending(
    [mk('a', 'A', 5), mk('b', 'B', 5), mk('c', 'C', 7), mk('d', 'D', 2)],
    8,
    10,
    false,
  );
  assert(packed.newGroups.length >= 2);
  assert(packed.newGroups.every((g) => groupHeadcount(g.parties) >= 8));

  const underflow = packPending([mk('x', 'X', 5), mk('y', 'Y', 2)], 8, 10, true);
  assert(underflow.newGroups.length === 1 && underflow.newGroups[0].underflow);

  const frozen = [{ group_index: 1, headcount: 10, parties: [] }];
  const doc = {
    summary: { group_count: 1, grouped_headcount: 10, pending_count: 2 },
    groups: frozen,
    pending: [
      { reason: 'group_underflow', phone: 'a', name: 'A', headcount: 5 },
      { reason: 'group_underflow', phone: 'b', name: 'B', headcount: 5 },
    ],
  };
  const tags = {
    lists: [mk('a', 'A', 5), mk('b', 'B', 5)],
  };
  const { groupsDoc: out } = resolveGroupsPending(doc, tags, { min_per_group: 8, max_per_group: 10 }, {});
  assert(out.groups[0].group_index === 1 && out.groups[0].headcount === 10);
  assert(out.groups.length === 2 && out.pending.length === 0);

  try {
    main();
  } catch (err) {
    console.error(`error: ${err.message}`);
    process.exit(1);
  }
}

module.exports = {
  resolveGroupsPending,
  packPending,
  loadPendingParties,
};
