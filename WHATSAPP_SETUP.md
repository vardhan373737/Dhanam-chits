# WhatsApp Integration Setup Guide

## Overview

Your Dhanam Chits application now has WhatsApp integration configured with the Meta WhatsApp Business API credentials.

## Current Configuration

The following WhatsApp credentials have been configured in your `.env` file:

- **Provider**: Meta (WhatsApp Business API)
- **Phone Number ID**: `9705412185`
- **Access Token**: Configured (secure token stored in `.env`)

## Files Created/Updated

### 1. `.env` (Updated)
Contains the WhatsApp credentials:
- `WHATSAPP_PROVIDER=meta` - Uses Meta as the primary provider
- `WHATSAPP_META_PHONE_NUMBER_ID` - Your Meta phone number ID
- `WHATSAPP_META_ACCESS_TOKEN` - Your Meta access token
- Fallback configuration for Twilio (optional)

### 2. `whatsapp-config.js` (New)
A comprehensive configuration module that:
- Centralizes all WhatsApp provider settings
- Provides validation methods for credentials
- Documents how to obtain credentials from Meta and Twilio
- Exports helper functions for API endpoints and authentication headers
- Includes retry and timeout configurations

### 3. `server.js` (Updated)
Now imports and utilizes the `whatsapp-config` module for better configuration management.

## How It Works

### Message Sending Flow

When a WhatsApp message needs to be sent:

1. **Provider Selection**: The system checks the configured provider (Meta in your case)
2. **Credential Validation**: Verifies that credentials are present in the environment
3. **API Request**: Sends the message via Meta's WhatsApp Business API
4. **Response Handling**: Returns success/failure status with message ID
5. **Fallback** (if configured): If Meta fails, attempts Twilio as fallback

### WhatsApp Functions in `server.js`

- `sendLenderWhatsAppViaMeta()` - Sends messages via Meta API
- `sendLenderWhatsAppViaTwilio()` - Sends messages via Twilio (fallback)
- `sendLenderWhatsAppReminder()` - Main function that orchestrates sending with retry logic
- `getWhatsAppProviderOrder()` - Determines provider order based on configuration

## Configuration Details

### Meta WhatsApp Business API

**Endpoint**: `https://graph.instagram.com/v20.0/{PHONE_NUMBER_ID}/messages`

**Required Credentials**:
- `WHATSAPP_META_PHONE_NUMBER_ID`: `9705412185` (your Meta phone number ID)
- `WHATSAPP_META_ACCESS_TOKEN`: Your secure access token

**Authentication**: Bearer token in Authorization header

**Message Format**:
```json
{
  "messaging_product": "whatsapp",
  "to": "+91xxxxxxxxxx",
  "type": "text",
  "text": { "body": "Your message here" }
}
```

### Twilio (Optional Fallback)

If you want to add Twilio as a fallback provider, configure:
- `TWILIO_ACCOUNT_SID`
- `TWILIO_AUTH_TOKEN`
- `TWILIO_WHATSAPP_FROM`
- `WHATSAPP_PROVIDER_ORDER=meta,twilio`

## Testing WhatsApp Configuration

To verify your configuration is working:

1. **Check Configuration Status**:
   ```bash
   node whatsapp-config.js
   ```
   This will display the current configuration status and any errors.

2. **Monitor Logs**: When messages are sent, check server logs for:
   - Success: `WhatsApp delivery: ok: true, provider: 'meta'`
   - Failure: `WhatsApp delivery: ok: false, error: '...'`

## Common Issues & Solutions

### ❌ "Meta WhatsApp credentials missing"
- **Cause**: `WHATSAPP_META_PHONE_NUMBER_ID` or `WHATSAPP_META_ACCESS_TOKEN` not set
- **Solution**: Verify both are correctly set in `.env` file

### ❌ "Invalid request format"
- **Cause**: Malformed phone number or message
- **Solution**: Ensure phone numbers are in E.164 format (e.g., +91xxxxxxxxxx)

### ❌ "Unauthorized access token"
- **Cause**: Token expired or invalid
- **Solution**: Generate a new token from Meta Developers console

### ❌ "Rate limit exceeded"
- **Cause**: Too many messages sent too quickly
- **Solution**: Implement message queuing (already in place with retry logic)

## Security Considerations

⚠️ **Important**: Your access token is sensitive!

1. **Never commit** `.env` to version control
2. **Never share** the access token publicly
3. **Rotate tokens** periodically for security
4. **Monitor API usage** in Meta Developers console
5. **Use `.env.example`** for sharing template without secrets

## Integration Points

### Where WhatsApp Messages Are Sent

In the application, WhatsApp messages are sent in these scenarios:

1. **Payment Reminders**: Automated reminders for upcoming payment due dates
2. **Status Updates**: Notifications when payment status changes
3. **Manual Messages**: Admin can send direct WhatsApp messages to lenders
4. **Delivery Confirmations**: Confirmations of important transactions

### Message Queue System

Messages are queued in the payment-pipeline with states:
- `queued`: Waiting to be processed
- `scheduled`: Scheduled for specific time
- `sent`: Successfully sent
- `failed`: Failed to send
- `retry_pending`: Waiting for retry

## Next Steps

1. ✅ **Verify Configuration**: Run `node whatsapp-config.js`
2. ✅ **Test Sending**: Send a test message through your admin panel
3. ✅ **Monitor Logs**: Check application logs for delivery status
4. ✅ **Implement Webhooks** (Optional): Add webhook handlers for delivery confirmations

## Additional Resources

- [Meta WhatsApp Business API Docs](https://developers.facebook.com/docs/whatsapp/cloud-api/)
- [Meta Developers Console](https://developers.facebook.com/)
- [WhatsApp Phone Number Management](https://developers.facebook.com/docs/whatsapp/cloud-api/reference/phone-numbers)

## Support

For issues or questions about WhatsApp integration:
1. Check the `.env` file for credential configuration
2. Review server logs for error messages
3. Validate credentials in Meta Developers console
4. Check API rate limits and account status
