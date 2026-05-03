# Automatic Payment Reminders - Quick Start

## ✅ Your System is ALREADY Automated!

Your Dhanam Chits application has **full automatic reminder sending** built in. No manual setup needed!

---

## How It Works (Simple Version)

### 1. **Daily Auto-Scheduling** 🤖
Every day when the server starts:
- System checks all active lender payments
- Finds any payment **due in 2 days**
- Automatically creates reminder jobs

### 2. **Background Processing** ⚙️
Every 15-20 seconds:
- System checks for reminders ready to send
- Sends WhatsApp via Meta API
- Tracks success/failure
- Auto-retries if it fails

### 3. **WhatsApp Delivery** 📱
- Message sent via Meta WhatsApp Business API
- Includes payment amount, due date, interest
- Provides payment link for easy checkout

---

## To Check Automation Status

**Command:**
```bash
curl http://localhost:5001/api/automation/status
```

**Response will show:**
- ✅ Reminder system status
- ✅ Lender system status  
- ✅ Queued/Sent/Failed counts
- ✅ WhatsApp provider status
- ✅ Last worker run time

---

## Manual Actions (From UI)

### Send Reminders Now
1. Open **Payment Reminder Center**
2. Click **"Bulk Send"** button
3. Select groups:
   - **All Overdue** - Send to overdue payments
   - **Due Soon** - Send to payments due within 7 days
   - **All Pending** - Send to all pending

### Schedule for Later
1. Click **"Schedule"** button
2. Set send time & date
3. Reminders will send at that time

### View What Happened
Click **"Audit Trail"** to see:
- When reminders were sent
- Success/failure status
- Message IDs
- Any errors

---

## API Endpoints (For Developers)

### Check Automation Status
```
GET /api/automation/status
```

### Send Bulk Reminders
```
POST /api/payment-reminder/pipeline/bulk-send
{
  "groups": {
    "all": true,        // overdue
    "dueSoon": true,    // due within 7 days  
    "pending": false    // all pending
  },
  "scheduleDate": "2026-05-10",  // optional
  "scheduleTime": "14:00"        // optional
}
```

### Retry Failed Reminder
```
POST /api/payment-reminder/pipeline/retry/:jobId
```

### View Audit Log
```
GET /api/payment-reminder/pipeline/audit?actor=system&status=success
```

---

## Configuration

### Change Auto-Remind Timing

In `server.js`, find line ~870:
```javascript
if (days !== 2) {  // Currently 2 days before due date
    return;
}
```

Change to:
- `days !== 1` → Remind 1 day before
- `days !== 3` → Remind 3 days before
- `days !== 7` → Remind 1 week before
- Remove condition → Remind for all due dates

### Customize Worker Speed

In `server.js`, find:
```javascript
setInterval(() => {
    processReminderPipelineJobs();
}, 15000);  // 15 seconds
```

Change to:
- `10000` → Every 10 seconds (faster)
- `60000` → Every 1 minute
- `300000` → Every 5 minutes

---

## Monitoring

### Watch Logs While Running
```bash
npm start 2>&1 | grep -E "reminder|Reminder"
```

### Check Queue Size
```bash
# View the reminder pipeline state file
cat uploads/reminder-pipeline-state.json | jq '.jobs | length'
```

### Check System Health
```bash
curl http://localhost:5001/api/automation/status | jq .
```

---

## Troubleshooting

### Reminders Not Sending

❌ **Problem:** Reminders stuck in "queued" status
- **Check:** Is the worker running? Look for "Worker error" in logs
- **Fix:** Restart the server with `npm start`

❌ **Problem:** "Meta WhatsApp credentials missing"  
- **Check:** Run `node whatsapp-config.js`
- **Fix:** Verify `.env` has `WHATSAPP_META_PHONE_NUMBER_ID` and `WHATSAPP_META_ACCESS_TOKEN`

❌ **Problem:** Reminders send but lender doesn't receive
- **Check:** Is phone number 10 digits?
- **Fix:** Phone numbers must be in format: 9876543210 (no +91 needed, added automatically)

❌ **Problem:** Same reminder sent multiple times
- **Check:** Is auto-scheduler disabled?
- **Fix:** Ensure `runDailyLenderAutoScheduler()` is called only once per day (it checks `lastAutoSchedulerRunAt`)

---

## What Happens Next

1. ✅ Server starts → Auto-scheduler runs once/day
2. ✅ Finds payments due in 2 days → Creates reminder jobs
3. ✅ Every 15 seconds → Worker checks for due jobs
4. ✅ Sends WhatsApp → Via Meta API
5. ✅ Tracks success → Updates job status
6. ✅ On failure → Retries up to 3 times with 5-min delays
7. ✅ Audit logged → All activities recorded

---

## Next Steps

1. ✅ **Test it:** Go to Payment Reminder Center → Click "Bulk Send"
2. ✅ **Monitor it:** Check "Audit Trail" for delivery status  
3. ✅ **Configure it:** Adjust timing if needed in `server.js`
4. ✅ **Deploy it:** System works on production servers too!

---

## Need Help?

Check these files:
- [AUTOMATIC_REMINDERS_GUIDE.md](AUTOMATIC_REMINDERS_GUIDE.md) - Full documentation
- [WHATSAPP_SETUP.md](WHATSAPP_SETUP.md) - WhatsApp configuration
- `.env` - Check credentials

**Test Status:**
```bash
node whatsapp-config.js
```

---

**Your reminders are running automatically! 🚀**

Every payment 2 days before due date will get an automatic WhatsApp reminder. Customize as needed!
