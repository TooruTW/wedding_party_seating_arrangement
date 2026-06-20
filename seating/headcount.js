/** seating headcount: total_attendee_count minus lists[].head_table_names.length */

function headTableNames(row) {
  if (!Array.isArray(row?.head_table_names)) return [];
  return row.head_table_names.filter((n) => typeof n === 'string' && n.trim());
}

function seatingHeadcount(row) {
  const total = Number(row?.total_attendee_count) || 0;
  return Math.max(0, total - headTableNames(row).length);
}

function validateHeadTableNames(row) {
  const names = row?.head_table_names;
  const total = Number(row?.total_attendee_count) || 0;
  if (names == null) return [];
  if (!Array.isArray(names)) return [['head_table_bad_type']];
  const errors = [];
  for (const n of names) {
    if (typeof n !== 'string' || !n.trim()) errors.push(['head_table_bad_name']);
  }
  const htCount = headTableNames(row).length;
  if (htCount > total) errors.push(['headcount_error', htCount, total]);
  return errors;
}

/** sync 時補上 head_table_names: []，方便 IDE 手改 */
function ensureHeadTableNamesField(entry) {
  if (entry.head_table_names != null) return entry;
  return { ...entry, head_table_names: [] };
}

module.exports = {
  headTableNames,
  seatingHeadcount,
  validateHeadTableNames,
  ensureHeadTableNamesField,
};
