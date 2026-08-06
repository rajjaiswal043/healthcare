# Demo — Phase 1 foundation

Ten minutes, no terminal once it's running. This is the walkthrough to use in front of a prospective clinic.

## Start

```powershell
# Once, if the demo data has been poked at:
pnpm --filter @healthcloud/db seed:demo

# Two terminals:
pnpm --filter @healthcloud/api dev     # http://localhost:3001
pnpm --filter @healthcloud/web dev     # http://localhost:3000
```

Open **http://localhost:3000**. You'll be sent to a sign-in page.

| Sign in as             | Password   | Can do                            |
| ---------------------- | ---------- | --------------------------------- |
| `reception@demo.local` | `demo1234` | Register and search               |
| `nurse@demo.local`     | `demo1234` | Search only — **cannot** register |
| `doctor@demo.local`    | `demo1234` | Register and search               |
| `admin@demo.local`     | `demo1234` | Forced to set up two-factor first |

Clinics: `sunrise-clinic`, `lotus-polyclinic`.

Start as **reception@demo.local**.

---

## 1. Register a patient — under two minutes, keyboard only

**Register a patient →**

Type, using Tab only — never the mouse:

| Field                   | Value                                                      |
| ----------------------- | ---------------------------------------------------------- |
| Full name               | `Sunita Deshmukh`                                          |
| Mobile                  | `+91 98765 43210` — deliberately messy, it gets normalised |
| Sex                     | Female                                                     |
| Age                     | `41`                                                       |
| City                    | `Pune`                                                     |
| Consent → Care delivery | tick                                                       |

**What to point out**

- **Age, not date of birth, by default.** Most Indian OPD patients don't know their DOB. Systems that force it end up with a register full of 01/01/1980 — data that looks complete and is worthless.
- **Consent is on the registration screen**, split by purpose. Care delivery is required; marketing is separate and optional. Under the DPDP Act consent must be purpose-wise, and bundling them is exactly what's prohibited.
- **The mobile is accepted in any format** and stored normalised, which is what makes duplicate detection work at all.

Submit → a UHID is issued: **`SNC00xxx`**, prefix configurable per clinic.

---

## 2. Duplicate detection — the interesting part

**Register another patient**, same details, same mobile.

Registration is **refused** with the existing record shown. This is the case that matters: the same person walking back in three months later, about to get a second file, a split allergy history, and a fragmented record.

Now click **"This is a different person — register anyway."** It proceeds. A mother and daughter genuinely do share a mobile number, and a system that can't express that gets worked around.

### The subtler point worth making

Register `Ramesh Kulkarni`, mobile `9822011223`.

While typing, a quiet grey note appears: _"3 similar names on file — probably unrelated."_ It does **not** block. Those are surname matches — `Radha Kulkarni`, `Amit Kulkarni` — unrelated people.

> An over-eager duplicate warning is worse than none. If staff see a warning on most registrations they learn it's usually wrong and click through it every time — including the one time it was right. So only a **same mobile**, or a **near-identical name with matching sex and age**, actually blocks.

---

## 3. Search

**Find a patient →** and type:

- `sharma` — fuzzy name match
- `9876543210` — mobile
- `SNC00042` — UHID

Results appear as you type. One box, because asking a receptionist to pick a field first is how you lose the two-minute target.

Try `sanjai` — it also finds `Sanjay`. Trigram matching handles the transliteration spread that makes Indian names hard: Sanjay/Sanjai, Mohammed/Muhammad.

---

## 3a. Roles — permissions that actually deny

Sign out. Sign in as **nurse@demo.local**.

The **Register a patient** tile is gone. That's cosmetic — the interesting part is that the server refuses too:

```
POST /api/v1/patients   as nurse
→ 403  {"code":"FORBIDDEN","message":"Missing permission: patient:write"}
```

> Hiding the button is a courtesy. The permission is enforced on the server, on every request, and the UI check exists only so nobody is offered a button that will fail. The frontend is untrusted — that's the golden rule in the checklist, and it's why the check exists in both places rather than only the convenient one.

Sign in as **admin@demo.local** to see two-factor being _required_, not offered: the administrator role holds every permission including the ability to grant permissions, so it cannot be used until TOTP is enrolled.

---

## 4. Tenant isolation — the one that matters to a hospital's IT committee

Note a patient's name in **Sunrise Clinic**. Sign out, and sign in to **lotus-polyclinic** with the same email.

Search for that same name. **Nothing.** Completely different patient list.

Worth saying explicitly: **the browser never tells the server which clinic it wants.** The tenant is carried in a signed session cookie the client cannot read or modify. Earlier in development it came from a request header — which would have meant any caller could simply ask for another clinic's data.

**What to say**

> This isn't a filter in the application code. Every patient table has a PostgreSQL row-level security policy, and the application connects as a database role that owns nothing and cannot bypass those policies. If a developer forgets a `WHERE tenant_id` clause, the database still returns zero rows — not another hospital's patients.
>
> There are 13 automated tests that try to break it: reading another tenant's record by its exact ID, updating it, deleting it, planting a row in it, and querying with no tenant context at all. They run on every commit.

Optionally show it:

```powershell
pnpm --filter @healthcloud/db test
```

---

## 5. The audit trail

Every read and write of patient data is recorded — who, what, when, from where, with a correlation ID.

```powershell
# psql, as the owner role, with tenant context set
```

Point out: the audit log stores **field names, never values**. An audit log full of patient data is a second copy of the thing you're protecting, usually with weaker access controls and a longer retention period.

---

## What is deliberately not here yet

Say this plainly — a demo that oversells gets found out at the pilot.

- **No appointments, consultation, prescriptions or billing.** Foundation first.
- **No user management UI.** Users and roles are seeded; creating and inviting them is API-only so far.
- **No password reset or change-password flow.** The `mustChangePassword` flag exists and is unused.
- **ABHA fields exist but aren't wired to ABDM.** The columns are in place so linking later is an update, not a migration on live patient data. The NHA sandbox application is a separate track.

What _is_ here is the part that's expensive to retrofit: tenant isolation enforced by the database, consent captured at the point of collection, and an audit trail that starts on day one.
