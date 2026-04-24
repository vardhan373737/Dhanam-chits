# Supabase Backend Migration

This project currently uses MongoDB in multiple servers. This guide introduces a Supabase-backed server so you can migrate safely in phases.

## 1) Create tables in Supabase

1. Open your Supabase project SQL editor.
2. Run the SQL from `supabase/schema.sql`.

## 2) Add environment file

Create `.env` from `.env.supabase.example` and set:

- `SUPABASE_URL`
- `SUPABASE_SERVICE_ROLE_KEY`
- `SESSION_SECRET`
- `SUPABASE_PORT`
- `SMTP_USER` (for statement emails)
- `SMTP_PASS` (for statement emails)
- `WHATSAPP_PROVIDER` (`meta`, `twilio`, or `auto`)
- `WHATSAPP_PROVIDER_ORDER` (for example `meta,twilio` to use Meta first and Twilio as fallback)
- `WHATSAPP_META_PHONE_NUMBER_ID`
- `WHATSAPP_META_ACCESS_TOKEN`
- `TWILIO_ACCOUNT_SID`
- `TWILIO_AUTH_TOKEN`
- `TWILIO_WHATSAPP_FROM`

## 3) Install dependencies

```bash
npm install
```

## 4) Run Supabase backend

```bash
npm run start:supabase
```

Health check:

- `GET /health`

## 5) Migrated routes currently available

- `POST /register`
- `POST /login` and `POST /Login`
- `POST /logout`
- `GET /api/users` (admin session required)
- `PUT /api/users/:id/password` (admin)
- `DELETE /api/users/:id` (admin)
- `POST /api/contact`
- `GET /api/contacts`
- `DELETE /api/contacts/:id`
- `POST /api/feedback`
- `GET /api/feedback`
- `GET /api/bank-details` (payments compatibility route)
- `POST /api/bank-details`
- `PUT /api/bank-details/:id/status`
- `GET /api/payments`
- `GET /api/payments/:mobile`
- `DELETE /api/payments/:id`
- `POST /api/bank-details/:id/send-statement`
- `POST /api/payments/send-statements/:mobile`
- `POST /api/bank-detail`
- `GET /api/bank-details/:mobile`
- `GET /api/bankdetails`
- `PUT /api/bank-details/:id`
- `DELETE /api/bank-details/:id`
- `POST /api/borrow`
- `GET /api/borrows`
- `GET /api/borrow-history/:mobile`
- `PUT /api/borrow/:id`
- `DELETE /api/borrow/:id`
- `GET /api/chit-ids`
- `GET /api/chit-ids/:chitId`
- `GET /api/chit-ids/mobile/:mobile`
- `POST /api/chit-ids`
- `POST /api/chit-ids/approve`
- `PUT /api/chit-ids/:id/status`
- `DELETE /api/chit-ids/:id`
- `GET /api/profile?mobile=<mobile>`
- `GET /submissions`
- `POST /submissions`
- `DELETE /submissions/:id`

## 6) Frontend fallback strategy in this repo

Frontend auth/contact/feedback and payment/borrow/chit/bank pages were updated to use Supabase backend (`http://localhost:5000`) first.
