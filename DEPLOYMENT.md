# Deployment Environment Variables

This project reads WhatsApp delivery settings from environment variables at runtime.

## Vercel

The repo already includes safe defaults in `vercel.json` for provider selection:

- `WHATSAPP_PROVIDER=auto`
- `WHATSAPP_PROVIDER_ORDER=meta,twilio`

Add the following secrets in the Vercel project settings:

- `SUPABASE_URL`
- `SUPABASE_SERVICE_ROLE_KEY`
- `SESSION_SECRET`
- `CASHFREE_APP_ID`
- `CASHFREE_SECRET_KEY`
- `CASHFREE_WEBHOOK_SECRET`
- `SMTP_USER`
- `SMTP_PASS`
- `WHATSAPP_META_PHONE_NUMBER_ID`
- `WHATSAPP_META_ACCESS_TOKEN`
- `TWILIO_ACCOUNT_SID`
- `TWILIO_AUTH_TOKEN`
- `TWILIO_WHATSAPP_FROM`
- `TWILIO_CONTENT_SID_STANDARD` (optional)
- `TWILIO_CONTENT_SID_URGENT` (optional)
- `TWILIO_CONTENT_SID_APPOINTMENT` (optional)
- `TWILIO_CONTENT_SID_ORDER` (optional)
- `TWILIO_CONTENT_SID_VERIFICATION` (optional)
- `TWILIO_CONTENT_SID_DEFAULT` (optional)

## Railway / Node server

Set the same variables in the Railway service variables or `.env` file:

- `PORT` or `SUPABASE_PORT`
- `SESSION_SECRET`
- `SUPABASE_URL`
- `SUPABASE_SERVICE_ROLE_KEY`
- `CASHFREE_APP_ID`
- `CASHFREE_SECRET_KEY`
- `CASHFREE_WEBHOOK_SECRET`
- `SMTP_USER`
- `SMTP_PASS`
- `WHATSAPP_PROVIDER`
- `WHATSAPP_PROVIDER_ORDER`
- `WHATSAPP_META_PHONE_NUMBER_ID`
- `WHATSAPP_META_ACCESS_TOKEN`
- `TWILIO_ACCOUNT_SID`
- `TWILIO_AUTH_TOKEN`
- `TWILIO_WHATSAPP_FROM`
- `TWILIO_CONTENT_SID_STANDARD` (optional)
- `TWILIO_CONTENT_SID_URGENT` (optional)
- `TWILIO_CONTENT_SID_APPOINTMENT` (optional)
- `TWILIO_CONTENT_SID_ORDER` (optional)
- `TWILIO_CONTENT_SID_VERIFICATION` (optional)
- `TWILIO_CONTENT_SID_DEFAULT` (optional)

## Exact provider values

Use one of these combinations:

### Meta only

- `WHATSAPP_PROVIDER=meta`
- `WHATSAPP_PROVIDER_ORDER=meta`
- Set `WHATSAPP_META_PHONE_NUMBER_ID`
- Set `WHATSAPP_META_ACCESS_TOKEN`

### Twilio only

- `WHATSAPP_PROVIDER=twilio`
- `WHATSAPP_PROVIDER_ORDER=twilio`
- Set `TWILIO_ACCOUNT_SID`
- Set `TWILIO_AUTH_TOKEN`
- Set `TWILIO_WHATSAPP_FROM`

### Fallback mode

- `WHATSAPP_PROVIDER=auto`
- `WHATSAPP_PROVIDER_ORDER=meta,twilio`
- Set both Meta and Twilio credentials

## Where To Find The Values

### Meta WhatsApp Cloud API

- `WHATSAPP_META_PHONE_NUMBER_ID`: Meta Developers dashboard -> your App -> WhatsApp -> API Setup.
- `WHATSAPP_META_ACCESS_TOKEN`: Meta Developers dashboard -> your App -> WhatsApp -> API Setup, or the System User / token area if you created a long-lived token.

### Twilio WhatsApp

- `TWILIO_ACCOUNT_SID`: Twilio Console home page.
- `TWILIO_AUTH_TOKEN`: Twilio Console home page -> Account Info.
- `TWILIO_WHATSAPP_FROM`: Twilio Console -> Messaging -> Try it out -> Send a WhatsApp message, or your approved WhatsApp sender number in E.164 format.

### If You Want Fallback Mode

- Set both Meta and Twilio credentials.
- Keep `WHATSAPP_PROVIDER=auto` and `WHATSAPP_PROVIDER_ORDER=meta,twilio`.
- The app will try Meta first and then Twilio if Meta fails or is missing credentials.

## Notes

- The app falls back to a `wa.me` share link when a provider is misconfigured or delivery fails.
- Secrets should be set in the deployment dashboard, not committed into source control.