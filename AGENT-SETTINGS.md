# Agent settings — what you asked for, and what I changed so you can do it yourself

## Short answer to your question

**No, you could not have done any of this yourself.** The AI Agent tab exposed
9 fields. The four you needed — widget icon, contact link, booking link, and
which model it runs on — were columns in the database that the Settings screen
never read and never wrote. The only way to change them was SQL.

That is now fixed. The tab exposes 14 fields and a new panel showing what the
assistant is actually running on.

---

## 1. Run this once

`scripts/update-agent-pricing-and-branding.sql` — paste into the Supabase SQL
editor.

It does the three things you asked for, and one you did not ask for but need.

**The one you did not ask for:** your new pricing text says *never quote a
"Document Essentials Pack"*. That instruction alone would not have worked,
because those package names are **already in the agent's knowledge base** —
somewhere in 13,804 characters. I watched the live agent quote a "Document
Essentials Pack" with per-student prices while testing it earlier today.
Appending correct pricing under contradictory text just gives the model two
sources and lets it choose, and it has already shown you which one it picks.

So the script removes every sentence mentioning the six invented packages
first, then appends your text verbatim under a heading that marks it
authoritative. Your 1,295 characters go in **exactly as written** — I verified
all 18 prices and facts byte-for-byte before writing the file.

The original knowledge is backed up to `app_settings` first, with a restore
command at the bottom of the script. Nothing is lost if the regex is too
aggressive.

Also set: `contact_url` and `booking_url` to `https://www.abrobot.ai/support`
(both, because the widget uses one for "Talk to expert" and the other for the
CTA button, and they pointed at two different places), and MNB Research's
`logo_url` to the favicon.

**Verify** with the query at the bottom of the file. All four
`still_has_bad_pack_*` columns must read `false`.

---

## 2. Then deploy the frontend

```
cd ~/Projects/mnb-recovery/repos/abrobot-crm-app && bash scripts/deploy-all.sh
```

---

## What is now editable in Settings → AI Agent

| Field | Why it matters |
|---|---|
| **Widget icon** | Per-org image URL, with a live preview |
| **Subtitle** | Blank falls back to *"Study-abroad assistant · online"* — wrong for a clinic or a law firm |
| **"Talk to expert" link** | Blank sends your visitors to **AbroBot's** contact page |
| **Booking link** | Blank sends them to a personal Calendly |
| **Model** | Which LLM answers, with the fallback chain explained |

Plus a **"What the assistant runs on"** panel: provider, model, reply-length
cap, knowledge size, whether guardrails are set, and whether the widget is
actually live.

### On the icon specifically

You asked how each website gets its own chatbot icon. It is a URL field, not an
upload — deliberately.

An upload needs Supabase Storage: a bucket, RLS policies on `storage.objects`,
a size limit, MIME validation, and an orphan-cleanup job. That is a day's work
and a new class of security surface, on a free tier with 1 GB of storage.

A URL field works today, costs nothing, and for the common case the answer is
already sitting there: **any site's favicon**. `yoursite.com/favicon.ico`, or
for Odoo sites like yours, `/web/image/website/1/favicon` — which is exactly
what I set for MNB Research. Square, ~128×128, any public host.

If a customer has no hosted image, upload is worth building. Until one asks, it
would be building for a problem nobody has.

**One caveat I would rather state than have you discover:** the field takes any
URL and does not validate that it loads. A broken URL hides the icon rather
than showing a broken-image box, so check the preview after pasting.

---

## What is still not in the UI

Editable in the database, deliberately not exposed:

- `temperature`, `max_tokens`, `capture_fields`, `languages`, `tone` — real
  knobs, but a customer turning temperature to 2.0 and getting nonsense is a
  support call you do not want. Shown read-only in the new panel instead.
- `guardrails` — displayed as set/not-set, not editable. These are the rules
  stopping the agent giving medical or legal advice. Worth a deliberate design
  before making them one textarea away from being deleted.
- `groq_api_key`, `resend_api_key`, `whatsapp_token`, `telegram_bot_token`,
  `app_secret` — **never** put these on this screen. They are columns on the
  same table, and the fact the TypeScript interface omits them is part of what
  stops them being selected into the browser by accident.

---

## After deploying, test it

The knowledge change is the one worth verifying, because the failure mode is
the agent confidently quoting a price that does not exist. Ask the live widget
on abrobot.ai:

1. *"What does AbroBot cost?"* — should give Free / Starter ₹999 / Growth
   ₹2,499 / Pro ₹4,999 / Elite ₹9,999, and nothing else.
2. *"Do you have a Document Essentials Pack?"* — should say no such thing
   exists. This is the direct test of the removal.
3. *"How many credits is a plagiarism scan?"* — 8.
4. *"Can I get a discount on the Elite plan?"* — should not invent one.

If any answer is wrong, send me what it said. The old knowledge is backed up,
so we can iterate without risk.
