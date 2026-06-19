#!/usr/bin/env node
/**
 * Generate data/guests.raw.json with random guest rows whose total_attendee_count sums to a target.
 * Usage: node scripts/generate-guests-raw.js <total_attendee_count>
 */
const fs = require('fs');
const path = require('path');

const ROOT = path.join(__dirname, '..');
const OUT_PATH = path.join(ROOT, 'data', 'guests.raw.json');

const RELATIONSHIPS = ['男方家人', '女方朋友', '女方家人', '男方朋友'];
const DOMAINS = ['yahoo.com.tw', 'gmail.com', 'icloud.com'];
const INVITATION_OPTIONS = [['紙本'], ['電子'], ['紙本', '電子']];
const FORM_SUBMITTED_AT = '2026/6/3 上午 11:14:26';

function randInt(min, max) {
  return Math.floor(Math.random() * (max - min + 1)) + min;
}

function pick(arr) {
  return arr[randInt(0, arr.length - 1)];
}

/** ponytail: greedy split; group count varies, each part 1–10, sum exact */
function splitAttendeeTotal(total) {
  if (!Number.isInteger(total) || total < 1) {
    throw new Error('total_attendee_count must be a positive integer');
  }
  const counts = [];
  let remaining = total;
  while (remaining > 0) {
    const max = Math.min(10, remaining);
    counts.push(remaining <= max ? remaining : randInt(1, max));
    remaining -= counts[counts.length - 1];
  }
  return counts;
}

function uniquePhones(count) {
  const phones = new Set();
  while (phones.size < count) {
    phones.add(`09${String(randInt(0, 99999999)).padStart(8, '0')}`);
  }
  return [...phones];
}

function makeGuest(index, attendeeCount, phone) {
  const hundred = randInt(100, 999);
  const babyCount = randInt(0, Math.min(3, attendeeCount));
  const vegetarianCount = randInt(0, Math.min(3, attendeeCount));

  return {
    phone,
    name: `測試${index}`,
    invitation_type: pick(INVITATION_OPTIONS),
    mail_address: `測試地址${hundred}號`,
    email_address: `testing${hundred}@${pick(DOMAINS)}`,
    relationship: pick(RELATIONSHIPS),
    total_attendee_count: attendeeCount,
    baby_count: babyCount,
    vegetarian_count: vegetarianCount,
    form_submitted_at: FORM_SUBMITTED_AT,
  };
}

function parseTotalArg() {
  const raw = process.argv[2];
  if (raw == null || raw === '' || raw === '--help' || raw === '-h') {
    console.error('Usage: node scripts/generate-guests-raw.js <total_attendee_count>');
    process.exit(raw === '--help' || raw === '-h' ? 0 : 1);
  }
  const total = Number(raw);
  if (!Number.isInteger(total) || total < 1) {
    console.error('total_attendee_count must be a positive integer');
    process.exit(1);
  }
  return total;
}

function main() {
  const total = parseTotalArg();
  const counts = splitAttendeeTotal(total);
  const phones = uniquePhones(counts.length);
  const guests = counts.map((n, i) => makeGuest(i + 1, n, phones[i]));

  fs.mkdirSync(path.dirname(OUT_PATH), { recursive: true });
  fs.writeFileSync(OUT_PATH, `${JSON.stringify(guests, null, 2)}\n`, 'utf8');

  const sum = guests.reduce((s, g) => s + g.total_attendee_count, 0);
  const uniquePhoneCount = new Set(guests.map((g) => g.phone)).size;
  if (sum !== total || uniquePhoneCount !== guests.length) {
    throw new Error(`self-check failed: sum=${sum} phones=${uniquePhoneCount}`);
  }

  console.log(`Wrote ${guests.length} guests (${total} attendees) → ${OUT_PATH}`);
}

main();
