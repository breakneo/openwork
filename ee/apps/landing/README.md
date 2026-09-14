# OpenWork Landing (Next.js)

## Local dev

1. Install deps from repo root:
   `pnpm install`
2. Run the app:
   `pnpm --filter @openwork-ee/landing dev`

### Optional env vars

- `NEXT_PUBLIC_CAL_URL` - enterprise booking link
- `LOOPS_API_KEY` - Loops API key for enterprise contact submissions
- `LANDING_FORM_ALLOWED_ORIGINS` - optional comma-separated origin allowlist for feedback/contact form posts

### Contact and feedback forms (Plain)

Both `/contact` and `/feedback` submit to `/api/app-feedback`. Following
[Plain's contact form flow](https://www.plain.com/docs/product/channels/contact-forms),
the server upserts a customer by email and creates a thread with the message,
submitted name, diagnostic context, and submission time. Existing customer
profiles are preserved, and new email addresses are marked unverified.
Plain automatically derives companies from customer email domains; the form does
not explicitly create companies or override company assignments.

Before enabling the forms in a deployment:

1. In Plain, open **Settings → Machine Users**, create a machine user, and add
   an API key with `customer:create`, `customer:edit`, `customer:read`,
   `thread:create`, and `thread:read` permissions.
2. Set `PLAIN_API_KEY` in the landing app's server environment (for local dev,
   use `ee/apps/landing/.env.local`). Never use a `NEXT_PUBLIC_` variable for it.
3. Configure [email sending](https://www.plain.com/docs/product/channels/email-sending)
   and [email receiving](https://www.plain.com/docs/product/channels/email-receiving)
   in Plain for `team@openworklabs.com` so the team can reply from Plain and
   receive follow-up emails there. This also routes the forms' direct email link
   into Plain.
4. Submit each form and verify the thread, customer email, diagnostic context,
   and email reply flow in Plain.

The forms no longer use Resend, SMTP, or internal feedback recipient overrides.
Without `PLAIN_API_KEY`, submissions return an unavailable response; this also
applies in local development. Use a separate Plain workspace/key for development
if you want to submit real requests. Submission itself creates a thread; configure
any automatic acknowledgement in Plain.

## Deploy (recommended)

This app is ready for Vercel or any Node-compatible Next.js host.

### Vercel

1. Create a new Vercel project rooted at `ee/apps/landing`.
2. Build command: `pnpm --filter @openwork-ee/landing build`
3. Output: `.next`
4. Start command: `pnpm --filter @openwork-ee/landing start`
5. Enable Vercel BotID for the project so protected form routes can reject automated submissions.

### Self-hosted

1. Build: `pnpm --filter @openwork-ee/landing build`
2. Start: `pnpm --filter @openwork-ee/landing start`
