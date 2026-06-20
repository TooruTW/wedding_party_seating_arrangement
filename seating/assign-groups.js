#!/usr/bin/env node
/**
 * Group parties from guests.tags.json by relationship_ids overlap.
 * - Exits if summary has pending_list or invalid_list
 * - Skips removed_from_raw
 * - Adds to a group only when relationship_ids overlap (>0) with a member
 * - Each group: min_per_group..max_per_group seating headcount (total − head_table_names)
 */
const fs = require('fs');
const path = require('path');
const { headTableNames, seatingHeadcount } = require('./headcount');

const ROOT = path.join(__dirname, '..');
const TAGS_PATH = path.join(ROOT, 'data', 'guests.tags.json');
const CONFIG_PATH = path.join(__dirname, 'groups-config.json');
const OUT_RESOLVED = path.join(ROOT, 'output', 'groups.json');
const OUT_PENDING = path.join(ROOT, 'output', 'groups.pending.json');

const dryRun = process.argv.includes('--dry-run');

function readJson(filePath, label) {
  try {
    return JSON.parse(fs.readFileSync(filePath, 'utf8'));
  } catch (err) {
    throw new Error(`${label} invalid JSON: ${err.message}`);
  }
}

function overlapCount(a, b) {
  const setA = new Set(a.relationship_ids ?? []);
  let n = 0;
  for (const id of b.relationship_ids ?? []) {
    if (setA.has(id)) n += 1;
  }
  return n;
}

function overlapWithGroup(party, group) {
  let n = 0;
  for (const member of group) n += overlapCount(party, member);
  return n;
}

function groupHeadcount(group) {
  return group.reduce((sum, p) => sum + seatingHeadcount(p), 0);
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

function assertPrerequisites(summary) {
  const pending = summary.pending_list ?? [];
  const invalid = summary.invalid_list ?? [];
  if (pending.length || invalid.length) {
    console.error('assign-groups: 請先完成標記再排組');
    if (pending.length) {
      console.error(`  pending (${pending.length}): ${pending.join(', ')}`);
    }
    if (invalid.length) {
      for (const row of invalid) {
        const types = (row.error ?? []).map((e) => e[0]).join(', ');
        console.error(`  invalid: ${row.phone} [${types}]`);
      }
    }
    process.exit(1);
  }
}

function loadParties(tagsDoc) {
  const lists = Array.isArray(tagsDoc.lists) ? tagsDoc.lists : [];
  return lists.filter((row) => !row.removed_from_raw && seatingHeadcount(row) > 0);
}

/** ponytail: greedy grow-by-overlap; O(n²) per group, fine for wedding-scale n */
function assignGroups(parties, minPerGroup, maxPerGroup) {
  const resolved = [];
  const pending = [];
  const seatingParties = parties.filter((p) => seatingHeadcount(p) > 0);
  let unassigned = [...seatingParties];

  for (const party of seatingParties) {
    const hc = seatingHeadcount(party);
    if (hc > maxPerGroup) {
      pending.push({
        reason: 'party_overflow',
        phone: party.phone,
        name: party.name,
        headcount: hc,
        max_per_group: maxPerGroup,
      });
      unassigned = unassigned.filter((p) => p.phone !== party.phone);
    }
  }

  while (unassigned.length) {
    let seed = unassigned[0];
    let bestSeedScore = -1;
    for (const candidate of unassigned) {
      let score = 0;
      for (const other of unassigned) {
        if (other.phone === candidate.phone) continue;
        score += overlapCount(candidate, other);
      }
      const hc = seatingHeadcount(candidate);
      if (score > bestSeedScore || (score === bestSeedScore && hc > seatingHeadcount(seed))) {
        bestSeedScore = score;
        seed = candidate;
      }
    }

    const group = [seed];
    unassigned = unassigned.filter((p) => p.phone !== seed.phone);

    while (unassigned.length) {
      const currentHc = groupHeadcount(group);
      if (currentHc >= maxPerGroup) break;

      let pick = null;
      let bestOverlap = -1;
      let bestHc = Infinity;
      for (const candidate of unassigned) {
        const addHc = seatingHeadcount(candidate);
        if (currentHc + addHc > maxPerGroup) continue;
        const ov = overlapWithGroup(candidate, group);
        if (
          ov > bestOverlap ||
          (ov === bestOverlap && addHc < bestHc)
        ) {
          bestOverlap = ov;
          bestHc = addHc;
          pick = candidate;
        }
      }
      if (!pick || bestOverlap < 1) break;

      group.push(pick);
      unassigned = unassigned.filter((p) => p.phone !== pick.phone);
    }

    const hc = groupHeadcount(group);
    if (hc >= minPerGroup && hc <= maxPerGroup) {
      resolved.push({
        group_index: resolved.length + 1,
        headcount: hc,
        parties: group.map(partySnapshot),
      });
    } else {
      for (const party of group) {
        pending.push({
          reason: hc < minPerGroup ? 'group_underflow' : 'group_overflow',
          phone: party.phone,
          name: party.name,
          headcount: seatingHeadcount(party),
          attempted_group_headcount: hc,
          min_per_group: minPerGroup,
          max_per_group: maxPerGroup,
        });
      }
    }
  }

  return { resolved, pending };
}

function assignGroupsFromTags(tagsDoc, config) {
  assertPrerequisites(tagsDoc.summary ?? {});
  const minPerGroup = Number(config.min_per_group) || 8;
  const maxPerGroup = Number(config.max_per_group) || 10;
  if (minPerGroup > maxPerGroup) {
    throw new Error('groups-config: min_per_group cannot exceed max_per_group');
  }

  const allActive = (Array.isArray(tagsDoc.lists) ? tagsDoc.lists : []).filter(
    (row) => !row.removed_from_raw,
  );
  const headTableOnlyCount = allActive.filter((row) => seatingHeadcount(row) === 0).length;

  const parties = loadParties(tagsDoc);
  const { resolved, pending } = assignGroups(parties, minPerGroup, maxPerGroup);

  return {
    summary: {
      party_count: parties.length,
      head_table_only_count: headTableOnlyCount,
      group_count: resolved.length,
      grouped_headcount: resolved.reduce((s, g) => s + g.headcount, 0),
      pending_count: pending.length,
      min_per_group: minPerGroup,
      max_per_group: maxPerGroup,
    },
    groups: resolved,
    pending,
  };
}

function printReport(result) {
  console.log('assign-groups');
  console.log(
    `  groups:  ${result.summary.group_count} 組 / ${result.summary.grouped_headcount} 人`,
  );
  for (const g of result.groups) {
    const names = g.parties
      .map((p) => {
        const ht =
          p.head_table_names?.length > 0 ? ` −主桌${p.head_table_names.length}` : '';
        return `${p.name}(${p.headcount}${ht})`;
      })
      .join(', ');
    console.log(`    #${g.group_index} [${g.headcount}] ${names}`);
  }
  if (result.summary.head_table_only_count) {
    console.log(`  head_table_only: ${result.summary.head_table_only_count} party 不參與分組`);
  }
  if (result.pending.length) {
    console.log(`  pending: ${result.pending.length}`);
    for (const p of result.pending) {
      console.log(`    ${p.phone} ${p.name}: ${p.reason}`);
    }
  } else {
    console.log('  pending: 0');
  }
}

function writeOutput(result) {
  fs.mkdirSync(path.dirname(OUT_RESOLVED), { recursive: true });
  fs.writeFileSync(OUT_RESOLVED, JSON.stringify(result, null, 2) + '\n', 'utf8');
  fs.writeFileSync(OUT_PENDING, JSON.stringify({ pending: result.pending }, null, 2) + '\n', 'utf8');
  console.log(`\nwritten: ${OUT_RESOLVED}`);
  console.log(`written: ${OUT_PENDING}`);
}

function main() {
  if (!fs.existsSync(TAGS_PATH)) {
    throw new Error(`guests.tags.json not found: ${TAGS_PATH}`);
  }
  const tagsDoc = readJson(TAGS_PATH, 'guests.tags.json');
  const config = readJson(CONFIG_PATH, 'groups-config.json');
  const result = assignGroupsFromTags(tagsDoc, config);
  printReport(result);
  if (!dryRun) writeOutput(result);
  else console.log('\n(dry-run, no files written)');
}

if (require.main === module) {
  // ponytail: overlap + bin cap smoke check
  const assert = (cond, msg) => {
    if (!cond) throw new Error(`self-check: ${msg}`);
  };
  const mk = (phone, name, hc, ids, headTable = []) => ({
    phone,
    name,
    total_attendee_count: hc,
    head_table_names: headTable,
    relationship_ids: ids,
    removed_from_raw: false,
  });
  assert(overlapCount(mk('a', 'A', 1, ['x', 'y']), mk('b', 'B', 1, ['y', 'z'])) === 1);
  const sample = assignGroups(
    [
      mk('1', '甲', 4, ['groom_family', 'rel_a']),
      mk('2', '乙', 5, ['groom_family', 'rel_a']),
      mk('3', '丙', 3, ['bride_family', 'rel_b']),
      mk('4', '丁', 6, ['bride_family', 'rel_b']),
    ],
    8,
    10,
  );
  assert(sample.resolved.length >= 1);
  assert(sample.resolved[0].headcount >= 8);
  const noLink = assignGroups(
    [
      mk('1', '甲', 5, ['groom_family']),
      mk('2', '乙', 4, ['bride_family']),
      mk('3', '丙', 1, ['groom_friends']),
    ],
    8,
    10,
  );
  assert(
    !noLink.resolved.some((g) => g.parties.length > 1 && g.parties.some((p) => p.phone === '3')),
    'no-overlap party must not join group',
  );
  assert(noLink.pending.some((p) => p.phone === '3'));
  const headOnly = assignGroups(
    [mk('h', '主桌代表', 2, ['groom_family'], ['父', '母'])],
    8,
    10,
  );
  assert(headOnly.resolved.length === 0 && headOnly.pending.length === 0);

  try {
    main();
  } catch (err) {
    console.error(`error: ${err.message}`);
    process.exit(1);
  }
}

module.exports = {
  assignGroupsFromTags,
  assignGroups,
  overlapCount,
  overlapWithGroup,
  loadParties,
  seatingHeadcount,
};
