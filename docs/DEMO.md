# Demo script (about 7 minutes)

**The story:** Asha, a health worker in a village with no signal, records a visit. Everything works offline. When she reaches coverage it syncs. Meanwhile a doctor edited the same patient on another device, and the conflict is resolved field by field, with an audit trail.

**Demo files** are in [demo-assets/](demo-assets/):
- `voice-note-fever.wav`: a spoken note in English
- `lab-report-photo.png`: a tilted, shadowed lab report photo
- `lab-report-printable.pdf`: print this to scan live with a camera

---

## The day before: setup checklist

1. **Start the server and seed the demo patient:**

   ```bash
   docker compose up -d --build
   docker compose exec backend python -m app.seed_demo   # Kamla Devi with 3 earlier visits
   cd frontend && npm run build && npx vite preview       # http://localhost:4173
   ```

2. **Window A** (normal Chrome profile): sign in as `asha` / `asha1234`.
   - Open a patient → **+ New consultation** → **Offline AI models**.
   - **Download** the speech model (Whisper Base) and the OCR data. Wait for "Ready offline".
   - Home → **Filters** → tick **Smart search**.
3. **Window B** (a second Chrome profile, or a guest window): sign in as `doctor` / `doctor123`. Open **Kamla Devi** once so she's on that device.
4. **Window C** (optional): sign in as `admin` / `admin123`, to show Staff, the audit log and remote wipe.
5. Do a full dry run once with Wi-Fi off. Then reset by re-seeding or using new patient names.
6. On stage:
   - Browser zoom 125 %.
   - DevTools closed, except the **Network → Offline** toggle if you use that instead of airplane mode.
   - Notifications silenced.

> **Tip:** turn off Wi-Fi, or use airplane mode, for real. It's more convincing than the DevTools toggle.

---

## The script

### 0:00 · The problem (30 s)
> "Rural health workers have no reliable internet, and records end up on paper. HCare captures visits by voice and camera, uses AI that runs entirely on the phone, and syncs safely when there's a signal. Watch: I'm turning Wi-Fi off now."

**Turn Wi-Fi off.** The badge changes to **Offline**.

### 0:30 · Offline, and secure (30 s), window A
- **Reload the page.** The app still loads (Service Worker), but shows **Locked**.
  > "Patient data on this phone is encrypted. Without the password it's unreadable, even if the phone is stolen."
- Enter `asha1234` → **Unlock**. Point out that **this works offline**.

### 1:00 · Patient history (45 s)
- Search **`bukhar`**. Kamla Devi's earlier **fever** visit appears.
  > "Search works in Hindi, Hinglish or English, offline, in milliseconds."
- Open **Kamla Devi** → **Patient history**:
  - the **allergy** (Penicillin)
  - the **BP trend** sparkline: tap a point to see its value
  - Haemoglobin falling
  - every line has a **date chip linking to its source visit**

### 1:45 · Capture a visit (1 min 15 s)
- **+ New consultation**.
- **Voice:** tap **🎙 Record** and speak. Try Hinglish: *"Teen din se bukhar hai, sukhi khansi, BP 150 over 95, paracetamol 500 mg din mein teen baar, penicillin se allergy."* Or **Upload audio file** → `voice-note-fever.wav`.
  > "Whisper is transcribing on the phone. No server, no internet."
- **Document:** **Upload image** → `lab-report-photo.png`, or photograph the printout.
  - Point out "**straightened 4°**".
  - Tap **Show cleaned image**.
  - Point out the highlighted **uncertain words**.
  > "Low-confidence words are flagged, so nobody trusts the OCR blindly."
- **Save & structure case file.**

### 3:00 · AI case file, clinician in control (1 min)
- The fields fill in: symptoms with durations, BP, the medicine with dose and frequency, the allergy, lab values from the photo.
- **Click a source chip**, e.g. "Rule · 90 % · Voice note 1". The exact sentence it came from is shown.
  > "Every value shows its source and confidence. The AI never invents a diagnosis; it's a test case."
- **The safety alert:** under **Medications**, add a row "Penicillin". The **Patient history** panel at the top now shows *"⚠ Check: Penicillin is prescribed in this visit, but the patient has a recorded allergy to it."* Then remove the row again.
- Edit one field. It turns **Edited**.
- **Verify & save.**
  > "Nothing is final until a clinician verifies it."

### 4:00 · Reconnect and sync (30 s)
- **Turn Wi-Fi on.** The badge goes **Pending → Syncing… → Synced**.
  > "Every change has a unique ID and a version. If the connection drops mid-sync, the retry can't create a duplicate."

### 4:30 · The conflict (1 min 30 s), windows B and A
*(Prepare before the demo: in window B, go offline and change Kamla Devi's **village** and **phone**. In window A, change her **village** and **age**.)*
- Bring **window B** back online. The badge shows **Conflict · 1**, and a banner appears.
- **Sync** → **Review & resolve**:
  > "Only the village was changed on both devices. That's the one real clash. Phone and age were each changed on one side, so they merged automatically."
- Choose a village → **Apply merge** → **Synced**.
- Show **Recently resolved**: *village: this device, phone: server…*
  > "Every decision goes into a tamper-evident audit log."

### 6:00 · Admin and security (45 s), window C
- **Audit log** → **Check integrity** → *"✓ Intact: all N entries verified."*
- **Staff:** add a doctor in one step. Deactivating cuts off their devices immediately.
- **Devices** → **Report lost & wipe**:
  > "If a phone is lost, its next connection erases all patient data on it."

### 6:45 · Close (15 s)
> "Offline-first, on-device AI, clinicians in control, and a sync engine that never loses or silently overwrites a record. Measured: 3.6 % speech word error rate, 2.1 % OCR character error rate, 100 % precision on case-file extraction, and over 180 automated tests including two-device conflicts."

---

## If something goes wrong

| Problem | Do this |
|---|---|
| Microphone blocked or noisy room | Use **Upload audio file** → `voice-note-fever.wav` |
| Transcription seems slow | The first run warms up the model. Do one practice clip before going on stage |
| "Download needed" on the models panel | You're offline before the models downloaded. Turn Wi-Fi on, download, then continue |
| Badge stuck on "Syncing…" | Check `docker compose ps`; the server must be up. Data is safe in the outbox meanwhile; say so, it's a feature |
| Conflict doesn't appear | Both windows must have edited the *same* patient while offline, and the other window must have synced first |
| Asked "what about Hindi?" | Whisper supports Hindi and 9 other Indian languages. Show the language picker. The rule extractor understands Hinglish and Devanagari: search `बुखार` |
| Asked "does it run on a cheap phone?" | The default models are small and run on CPU. The large LLM is offered only where WebGPU exists, because we measured it running out of memory on CPU (see EVALUATION.md) |
