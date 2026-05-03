# Automatic Payment Reminder Setup Guide

## System Overview

Your Dhanam Chits application has a **fully automated payment reminder system** that:

1. **Daily Auto-Scheduler** - Automatically queues reminders 2 days before payment due date
2. **Background Worker** - Processes queued reminders every 20 seconds  
3. **WhatsApp Integration** - Sends reminders via Meta WhatsApp Business API
4. **Smart Retry Logic** - Automatically retries failed reminders up to 3 times
5. **Audit Trail** - Tracks all reminder activities for compliance

---

## How Automatic Reminders Work

### Phase 1: Auto-Scheduling (Daily)
```
Every day at server startup:
├─ Check all active lender payments
├─ Identify lenders with payment due in 2 days
├─ Queue automatic reminder jobs
└─ Log action in audit trail
```

**Example:**
- Payment due: May 10
- Auto-reminder queued: May 8 (automatically)
- Status: `queued`

### Phase 2: Job Processing (Every 20 seconds)
```
Every 20 seconds, background worker:
├─ Read pending reminder jobs
├─ Check if scheduled time has arrived
├─ Send WhatsApp via Meta API
├─ Update job status to 'sent' or 'failed'
├─ Retry on failure (max 3 attempts)
└─ Log all activities
```

### Phase 3: Delivery & Retry
```
If delivery succeeds:
✅ Status → 'sent'
✅ Message ID recorded
✅ Audit logged

If delivery fails:
❌ Attempt +1
❌ If attempt < 3: Reschedule in 5 minutes
❌ If attempt ≥ 3: Status → 'failed'
```

---

## Configuration Options

### 1. Enable/Disable Auto-Scheduling (server.js)

The auto-scheduler currently targets lenders **2 days before due date**.

To customize, in `server.js`, find:
```javascript
const days = lenderDaysUntilDue(lender.dueDate);
if (days !== 2) {  // ← Change this number
    return;
}
```

**Options:**
- `days !== 1` - Remind 1 day before
- `days !== 3` - Remind 3 days before  
- `days !== 7` - Remind 1 week before
- Remove condition to remind for ALL due dates

### 2. Worker Interval Frequency

In `server.js`, find:
```javascript
setInterval(() => {
    processLenderReminderJobs();
}, 20000);  // ← 20000ms = 20 seconds
```

**Options:**
- `10000` - Every 10 seconds (faster)
- `60000` - Every 1 minute
- `300000` - Every 5 minutes (slower)

### 3. Retry Attempts

In `server.js`, find:
```javascript
if (job.attempts < Number(job.maxAttempts || 3)) {  // ← Change 3 to desired count
    job.status = 'retry_pending';
}
```

---

## Using the UI (payment-reminderA.html)

### Option 1: Bulk Send Immediate Reminders

1. Open **Payment Reminder Center**
2. Click **"Bulk Send"** button
3. Select recipients:
   - ✓ All Overdue - Overdue payments only
   - ✓ Due Soon (7 days) - Payments due within 7 days
   - ✓ All Pending - All pending reminders
4. Click **"Send Reminders"**
5. Status updates appear in audit trail

### Option 2: Schedule Reminders for Later

1. Open **Payment Reminder Center**
2. Click **"Schedule"** button
3. In form, click **"Schedule Send Time"**
4. Select time slot: 09:00 AM, 12:00 PM, 03:00 PM, 06:00 PM
5. Select send date
6. Fill other fields (amount, reason, etc.)
7. Click **"Save Reminder"**
8. Reminders will be sent at scheduled time

### Option 3: API-Based Bulk Send

**Endpoint:** `POST /api/payment-reminder/pipeline/bulk-send`

**Request:**
```json
{
  "groups": {
    "all": true,          // Include overdue
    "dueSoon": true,      // Include due within 7 days
    "pending": false      // Don't include all pending
  },
  "scheduleDate": "2026-05-10",  // Optional: schedule for specific date
  "scheduleTime": "14:00"        // Optional: specific time (HH:MM format)
}
```

**Response:**
```json
{
  "ok": true,
  "message": "45 reminders queued for delivery",
  "jobIds": ["uuid-1", "uuid-2", ...],
  "scheduledFor": "2026-05-10T14:00:00Z"
}
```

---

## Monitoring & Troubleshooting

### 1. Check Reminder Status

Look at reminder cards in the **Payment Reminder Center**:
- 🟢 **Sent** - Successfully delivered via WhatsApp
- 🟡 **Queued** - Waiting to be processed
- 🔄 **Retry Pending** - Failed, will retry in 5 min
- 🔴 **Failed** - All retries exhausted

### 2. View Audit Trail

Click **"Audit Trail"** button to see:
- When reminders were sent
- Success/failure status
- Which provider (Meta WhatsApp)
- Message IDs (for troubleshooting)
- Admin actions

### 3. Common Issues

**Issue:** Reminders not sending
```
✅ Check: WhatsApp Meta credentials in .env
✅ Verify: WhatsApp_PROVIDER=meta in .env
✅ Test: node whatsapp-config.js
✅ Check: Server logs for "Worker error"
```

**Issue:** Reminders sending to wrong people
```
✅ Check: Phone numbers are 10 digits
✅ Verify: Payment status not marked as 'paid'
✅ Check: Mobile number format (no spaces/dashes)
```

**Issue:** Reminders sending too late/early
```
✅ Check: Server time zone is correct
✅ Verify: ScheduledFor timestamp in reminder card
✅ Check: Worker interval setting (20s default)
```

### 4. View Logs

Check server console/logs:
```bash
# Worker processing
Lender reminder worker error: ...

# Send success
Reminder sent via meta for +919876543210

# Send failure
WhatsApp delivery failed: Invalid access token
```

---

## Best Practices

### 1. ✅ Do
- ✅ Schedule bulk reminders during business hours
- ✅ Monitor audit trail daily for failures
- ✅ Keep WhatsApp credentials secure in `.env`
- ✅ Test with a small group first
- ✅ Review failed reminders and retry manually
- ✅ Backup audit logs periodically

### 2. ❌ Don't
- ❌ Send reminders at odd hours (affects response rate)
- ❌ Ignore failed deliveries
- ❌ Manually send duplicate reminders to same person
- ❌ Share WhatsApp access tokens
- ❌ Keep old audit logs (they grow large)
- ❌ Change due date calculation logic without testing

---

## Advanced Configuration

### 1. Custom Message Templates

In `server.js`, find `buildReminderMessage()` to customize:
```javascript
return `Hi ${name}! Your payment of ₹${amount} is due on ${dueDate}. Please pay at your earliest convenience.`;
```

### 2. Change Auto-Trigger Rule

From "2 days before" to custom logic:

**Example: Remind every day until paid**
```javascript
// In runDailyLenderAutoScheduler()
state.lenders.forEach((lender) => {
  if (String(lender.status || '').toLowerCase() === 'closed') {
    return;
  }
  const days = lenderDaysUntilDue(lender.dueDate);
  
  // Queue reminder every day starting from due date
  if (days <= 0) {  // Changed from days !== 2
    const autoRuleKey = `${lender.id}:${lender.dueDate}:daily-overdue`;
    // ... rest of queuing logic
  }
});
```

### 3. Implement Rate Limiting

Add a delay between reminders to avoid overwhelming lenders:

```javascript
const DELAY_BETWEEN_REMINDERS_MS = 2000; // 2 second delay
for (const job of dueJobs) {
  // ... send reminder
  await new Promise(resolve => setTimeout(resolve, DELAY_BETWEEN_REMINDERS_MS));
}
```

---

## Timeline Example

**Scenario:** Lender payment due on May 15

```
May 13 (09:00 AM)
├─ Auto-scheduler runs at server startup
├─ Payment found: due in 2 days
└─ Job queued with status: 'queued'

May 13 (09:20 AM)
├─ Worker checks jobs every 20 seconds
├─ Finds queued job
├─ Sends WhatsApp via Meta API
└─ Job status: 'sent' ✅

Result: Lender receives reminder on WhatsApp 2 days early!
```

---

## API Reference

### Bulk Send
```
POST /api/payment-reminder/pipeline/bulk-send
Body: { groups: { all, dueSoon, pending }, scheduleDate?, scheduleTime? }
Response: { ok, message, jobIds, scheduledFor }
```

### Retry Failed Job
```
POST /api/lenders/reminders/:jobId/retry
Response: { ok, message, job }
```

### Schedule Lender Reminder
```
POST /api/lenders/:id/reminders/schedule
Body: { message, scheduleDate, scheduleTime, templateType }
Response: { ok, message, jobId }
```

### Check Pipeline Status
```
GET /api/payment-reminder/pipeline/status
Response: { pendingJobs, failedJobs, processedToday, lastWorkerRun }
```

---

## Support & Debugging

### Enable Debug Logging

In `server.js`, add to `processLenderReminderJobs()`:
```javascript
console.log(`[REMINDER WORKER] Processing ${dueJobs.length} jobs at ${new Date().toISOString()}`);
```

### Test Reminder Manually

```javascript
// In Node.js console:
const result = await sendLenderWhatsAppReminder({
  mobile: '+919876543210',
  message: 'Test reminder',
  templateType: 'standard'
});
console.log(result);
```

### Monitor Job Queue

Check `uploads/reminder-pipeline-state.json` to see:
- All pending jobs
- Failed jobs
- Audit history
- Notification queue

---

## Next Steps

1. ✅ Verify WhatsApp credentials are configured (`node whatsapp-config.js`)
2. ✅ Test bulk send with a small group
3. ✅ Monitor audit trail for first 24 hours
4. ✅ Customize auto-trigger timing if needed
5. ✅ Set up regular audit log backups
6. ✅ Train team on using Payment Reminder Center

**Server will automatically send reminders 2 days before each payment due date!** 🚀
