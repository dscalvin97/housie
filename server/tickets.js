// Standard tambola ticket generation.
// Invariants (checked by test/selfcheck.js): 15 numbers, exactly 5 per row,
// 1-3 per column bucket, numbers strictly ascending across rows and down columns.

const COL_BUCKETS = Array.from({ length: 9 }, (_, c) =>
  c < 8 ? Array.from({ length: 9 }, (_, i) => c * 10 + i + 1) : Array.from({ length: 10 }, (_, i) => 81 + i)
);

function randomCounts(rng) {
  // 9 columns, each 1..3 numbers, summing to 15
  const counts = Array(9).fill(1);
  let left = 6;
  while (left > 0) {
    const c = Math.floor(rng() * 9);
    if (counts[c] < 3) { counts[c]++; left--; }
  }
  return counts;
}

function combos(arr, k) {
  const out = [];
  (function rec(start, acc) {
    if (acc.length === k) { out.push([...acc]); return; }
    for (let i = start; i < arr.length; i++) { acc.push(arr[i]); rec(i + 1, acc); acc.pop(); }
  })(0, []);
  return out;
}

// Assign each column's slot-count to rows so every row ends up with exactly 5 numbers.
function assignRows(counts) {
  const cap = [5, 5, 5];
  const assign = [[], [], []];
  const order = counts.map((n, c) => [n, c]).sort((a, b) => b[0] - a[0]).map(x => x[1]);
  function bt(k) {
    if (k === order.length) return true;
    const c = order[k], n = counts[c];
    for (const combo of combos([0, 1, 2], n)) {
      if (!combo.every(r => cap[r] >= 1)) continue;
      combo.forEach(r => { cap[r]--; assign[r].push(c); });
      if (bt(k + 1)) return true;
      combo.forEach(r => { cap[r]++; assign[r].pop(); });
    }
    return false;
  }
  return bt(0) ? assign : null;
}

export function generateTicket(rng = Math.random) {
  for (let attempt = 0; attempt < 200; attempt++) {
    const counts = randomCounts(rng);
    const assign = assignRows(counts);
    if (!assign) continue;

    // Per column, pick `counts[c]` distinct numbers from its bucket.
    const pickedByCol = {};
    for (let c = 0; c < 9; c++) {
      const nums = [...COL_BUCKETS[c]];
      for (let i = 0; i < counts[c]; i++) {
        const j = i + Math.floor(rng() * (nums.length - i));
        [nums[i], nums[j]] = [nums[j], nums[i]];
      }
      pickedByCol[c] = nums.slice(0, counts[c]).sort((a, b) => a - b);
    }

    // Which rows each column lands in (ascending), so column numbers stay sorted top-to-bottom.
    const colRows = {};
    for (let r = 0; r < 3; r++) for (const c of assign[r]) (colRows[c] ??= []).push(r);

    const grid = [[], [], []];
    for (let r = 0; r < 3; r++) grid[r] = Array(9).fill(null);
    for (let c = 0; c < 9; c++) {
      (colRows[c] ?? []).sort((a, b) => a - b).forEach((r, i) => { grid[r][c] = pickedByCol[c][i]; });
    }
    return { rows: grid };
  }
  throw new Error('ticket generation failed');
}

export function generateTickets(n) {
  return Array.from({ length: n }, () => generateTicket());
}
