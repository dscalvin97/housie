// Declarative pattern engine for tambola (3x9) tickets.
// A ticket is { rows: [[num|null]*9] *3 } — exactly 5 numbers per row.
// Cell selectors address the k-th marked number of a row (0-based among the row's 5).

const CELL = { first: 0, mid: 2, last: 4 };

export const PATTERNS = {
  earlyFive: { id: 'earlyFive', name: 'Early Five', desc: 'First 5 numbers anywhere on the ticket', rule: { type: 'anyN', n: 5 } },
  topLine:   { id: 'topLine',   name: 'Top Line',    desc: 'All 5 numbers of the top row',        rule: { type: 'row', row: 0 } },
  midLine:   { id: 'midLine',   name: 'Middle Line', desc: 'All 5 numbers of the middle row',     rule: { type: 'row', row: 1 } },
  bottomLine:{ id: 'bottomLine',name: 'Bottom Line', desc: 'All 5 numbers of the bottom row',     rule: { type: 'row', row: 2 } },
  corners:   { id: 'corners',   name: 'Four Corners',desc: 'First & last numbers of top and bottom rows', rule: { type: 'corners' } },
  star:      { id: 'star',      name: 'Star',        desc: 'Four corners + first, middle & last of the middle row', rule: { type: 'cells', cells: [[0,'first'],[0,'last'],[1,'first'],[1,'mid'],[1,'last'],[2,'first'],[2,'last']] } },
  pyramid:   { id: 'pyramid',   name: 'Pyramid',     desc: 'Middle of top row, 2nd & 4th of middle row, 1st, 3rd & 5th of bottom row', rule: { type: 'cells', cells: [[0,'mid'],[1,1],[1,3],[2,0],[2,2],[2,4]] } },
  fullHouse: { id: 'fullHouse', name: 'Full House',  desc: 'All 15 numbers on the ticket',        rule: { type: 'all' } },
};

// Numbers a fixed-set rule requires, or null for anyN rules.
export function patternNumbers(ticket, rule) {
  switch (rule.type) {
    case 'row':
      return ticket.rows[rule.row].filter(Boolean);
    case 'corners':
      return [firstOf(ticket.rows[0]), lastOf(ticket.rows[0]), firstOf(ticket.rows[2]), lastOf(ticket.rows[2])];
    case 'cells':
      return rule.cells.map(([r, k]) => rowCells(ticket.rows[r])[typeof k === 'string' ? CELL[k] : k]);
    case 'all':
      return ticket.rows.flat().filter(Boolean);
    case 'anyN':
      return null;
    default:
      throw new Error(`unknown rule type: ${rule.type}`);
  }
}

function rowCells(row) { return row.filter(Boolean); }
function firstOf(row) { return row.find(Boolean); }
function lastOf(row) { for (let i = row.length - 1; i >= 0; i--) if (row[i] != null) return row[i]; }

// Draw index (0-based) at which this ticket completed this pattern, or null if not complete.
// anyN completes at the draw when its n-th number was called.
export function completionDraw(ticket, rule, callIndex) {
  if (rule.type === 'anyN') {
    const idxs = ticket.rows.flat().filter(Boolean).map(n => callIndex[n]).filter(i => i !== undefined).sort((a, b) => a - b);
    return idxs.length >= rule.n ? idxs[rule.n - 1] : null;
  }
  const nums = patternNumbers(ticket, rule);
  let max = -1;
  for (const n of nums) {
    const i = callIndex[n];
    if (i === undefined) return null;
    if (i > max) max = i;
  }
  return max;
}

// UI helper: which cells of a ticket a pattern covers, as "r-c" keys.
export function patternCellKeys(ticket, rule) {
  const keys = [];
  if (rule.type === 'anyN') return keys;
  if (rule.type === 'all') {
    ticket.rows.forEach((row, r) => row.forEach((n, c) => { if (n != null) keys.push(`${r}-${c}`); }));
    return keys;
  }
  const nums = new Set(patternNumbers(ticket, rule));
  ticket.rows.forEach((row, r) => row.forEach((n, c) => { if (n != null && nums.has(n)) keys.push(`${r}-${c}`); }));
  return keys;
}
