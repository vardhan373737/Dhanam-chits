// Simple simulation of the WhatsApp reminder message preview
function formatAmount(n) {
  if (typeof n === 'number') return n.toLocaleString('en-IN');
  return String(n || '0');
}

const name = 'Shank nani';
const borrowDate = '2026-04-15';
const repaymentDate = '2026-05-16';
const daysLine = '2 days';
const safePrincipal = 62000;
const interestRate = 0;
const interestAmount = 0;

// EMI fields for simulation
const emiAmount = 5000; // current EMI amount
const pendingEmis = 2; // number of pending EMIs
const pendingEmiAmount = 10000; // total pending amount
const paidEmis = 1; // number of EMIs already paid
const emiPaidAmount = 5000; // amount paid for EMIs
const balance = 52000; // remaining balance
const monthsRemaining = 12.4;
const monthlyEmi = 5000;
const isEmi = Boolean(emiAmount) || Boolean(monthlyEmi) || Boolean(monthsRemaining) || Boolean(pendingEmis) || Boolean(paidEmis) || Boolean(balance);
const heading = isEmi ? '🔔 *EMI Payment Reminder*' : '🔔 *Payment Reminder*';
const lines = [
  heading,
  '',
  `*Dear ${name},*`,
  '',
  `📌 *Borrow:* ${borrowDate}`,
  `📅 *Due:* ${repaymentDate} — *${daysLine} left*`,
  '',
  `💰 *Principal:* ₹${formatAmount(safePrincipal)}`,
];

lines.push(`💸 *EMI:* ₹${formatAmount(emiAmount)}`);
lines.push(`🔢 *Months Remaining:* ${monthsRemaining}`);
lines.push(`💳 *Monthly:* ₹${formatAmount(monthlyEmi)}`);

if (pendingEmis || pendingEmiAmount) {
  const pendingCount = pendingEmis ? `${pendingEmis} EMI${pendingEmis > 1 ? 's' : ''}` : '';
  const pendingAmt = pendingEmiAmount ? ` (₹${formatAmount(pendingEmiAmount)})` : '';
  lines.push(`⏳ *Pending:* ${pendingCount}${pendingAmt}`.trim());
}
if (emiPaidAmount || paidEmis) {
  const paidCount = paidEmis ? `${paidEmis} EMI${paidEmis > 1 ? 's' : ''}` : '';
  const paidAmt = emiPaidAmount ? ` (₹${formatAmount(emiPaidAmount)})` : '';
  lines.push(`✅ *Paid:* ${paidCount}${paidAmt}`.trim());
}
if (balance) {
  lines.push(`🏦 *Balance:* ₹${formatAmount(Number(balance) || 0)}`);
}

lines.push('');
lines.push('Kindly complete the payment at the earliest.');

console.log(lines.join('\n'));
