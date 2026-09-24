# Runbook — ABDM sandbox access (NHA)

**Owner:** Narveer · **Do this during Phase 1** — it's a form-and-wait process, and the wait is the point. The ABHA code lands in Phase 4, but if the application starts then, the wait becomes the critical path.

> **Verify before you rely on this.** ABDM's portal, forms and milestone definitions change without much ceremony, and your own BRD (Appendix A) says the team must confirm current versions at sprint zero. Treat the steps below as the shape of the process, and the live portal as the authority. If something contradicts this document, the portal wins — tell me and I'll update it.

---

## 1. What we're applying for, and what we're not

|                                               | Now (Phase 1)                     | Later (parked)                                                           |
| --------------------------------------------- | --------------------------------- | ------------------------------------------------------------------------ |
| **Sandbox access** to ABDM V3 APIs            | ✅ this runbook                   |                                                                          |
| **M1** — ABHA creation, verification, linking | ✅ what we'll build in Phase 4    |                                                                          |
| M2 (HIP) / M3 (HIU) — record sharing          |                                   | Needs third-party Functional Testing + CERT-In WASA. Parked per plan §2. |
| M4 — NHCX claims                              |                                   | Parked.                                                                  |
| **HFR / HPR registration**                    | Per-facility, done by each clinic | Belongs in the customer-onboarding runbook, not this one                 |

Two things people conflate, so worth stating plainly:

- **Software certification** (what we're doing) is about our platform passing ABDM's milestone tests.
- **Facility registration** (HFR) and **clinician registration** (HPR) are done by each hospital or clinic, independently of our certification. Your pilot clinics do this themselves; BRD A-03 already assumes it.

---

## 2. Gather before you start

Have these to hand — a half-finished application that times out is worse than a delayed one.

**Entity**

- [ ] Registered legal entity name (exactly as on incorporation documents)
- [ ] Entity type — private limited, LLP, proprietorship
- [ ] CIN / LLPIN, PAN, GSTIN
- [ ] Registered address, state, PIN
- [ ] Certificate of incorporation (PDF)

> If the company isn't incorporated yet, this is your blocker, not the ABDM form. NHA expects a registered entity. Flag it to me — it changes the phase ordering, since a sole-proprietor route is possible but weaker for hospital procurement later.

**Contacts**

- [ ] Primary technical contact — name, designation, mobile, **email on your own domain** (a Gmail address reads as unserious to a government reviewer and is sometimes rejected outright)
- [ ] Authorised signatory — name, designation, contact

**Product**

- [ ] Product/solution name — this is **BRD OQ-01**, still open. You can apply under the entity name and a working product name; just be aware it's what appears on the ABDM listing. Worth deciding before submitting.
- [ ] One-paragraph description. Draft: _"A multi-tenant healthcare CRM and clinic management platform for Indian outpatient providers, covering patient registration and longitudinal records, appointment and queue management, consultation and e-prescription, and outpatient billing. ABDM integration is used to create, verify and link ABHA identities to the provider's local patient record, with consent captured and retained per the DPDP Act."_
- [ ] Category — health-tech software provider / HMIS
- [ ] Intended milestone: **M1 first**, with M2/M3 stated as roadmap

**Technical**

- [ ] Callback / redirect URLs. Sandbox can use `http://localhost:3000/api/abdm/callback` initially; a stable staging URL is better if you have one. **Tell me what you register — the code has to match it exactly.**
- [ ] Static outbound IP, if the form asks. We don't have one until the EC2 box exists (Phase 5), so leave blank or use your current IP and expect to update it.

---

## 3. Steps

1. **Create an account** at `sandbox.abdm.gov.in`. Verify the email and mobile.
2. **Complete the entity profile** with §2 details and upload documents.
3. **Register the application/solution**, selecting the ABHA / M1 capability set and V3 APIs. _(V3 is mandatory for new development — BRD §7.2. If the form offers v0.5 or v1.0, that's legacy; don't pick it.)_
4. **Receive sandbox credentials** — typically a client ID and client secret.
5. **Send them to me securely — but not by pasting them into this chat, and never into the repo.** Put them in a password manager, or set them directly in your local `.env` (which is gitignored). The env module will read `ABDM_CLIENT_ID` and `ABDM_CLIENT_SECRET`; I'll write the code against those names and never need to see the values.
6. **Note the exact base URLs** issued for sandbox gateway and ABHA services, and paste those here — they differ between environments and are the single most common source of wasted debugging.
7. **Record the date submitted and any ticket/reference number** in §5 below.

---

## 4. What happens after approval

Not needed now, recorded so the shape is known:

- Build M1 flows against sandbox (Phase 4), covering Aadhaar-OTP and mobile-OTP ABHA creation, verification by number/address/QR, and linking to our UHID.
- Demonstrate the milestone to NHA — usually a recorded walkthrough or screenshots against defined test cases.
- **Production access** additionally requires third-party **Functional Testing** and a **CERT-In-empanelled WASA** security assessment. Both have queues and costs. Budget them when M2/M3 get unparked; they are the main schedule risk in BRD R-02.

---

## 5. Status log

| Date | Action                     | Reference / notes                                  |
| ---- | -------------------------- | -------------------------------------------------- |
|      | Account created            |                                                    |
|      | Application submitted      |                                                    |
|      | Credentials received       | stored in password manager — **never in the repo** |
|      | Sandbox base URLs recorded |                                                    |

---

## 6. What I need back from you

Nothing blocking Phase 1. When you have them:

1. The **exact callback URL** you registered.
2. The **sandbox base URLs** issued.
3. Confirmation that credentials are in your local `.env` under `ABDM_CLIENT_ID` / `ABDM_CLIENT_SECRET`.
4. The **product name**, if the application forced you to settle OQ-01.
