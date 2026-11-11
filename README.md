# Cymbal Auto Group — Vehicle ID & Trade-In AI Platform

A trade-in vehicle appraisal web & mobile application built for dealership sales staff (**Cymbal Auto Group**). Note: This repository contains the clean application codebase only with **zero pre-seeded vehicle data or test inventory**.

Salespeople capture or select a short walkaround video of a customer's trade-in vehicle on their mobile phone or desktop while narrating observations. The app uploads the video to **Cloud Storage**, invokes the **Vehicle Inspector AI Agent** and **Valuation Bot AI Agent** (powered by **`gemini-3.8-flash`** via `google-genai`), verifies official UK registration details, and saves the structured inspection and valuation dossier to **BigQuery**.

---

## Architecture & Security Highlights

- **Compute**: **Cloud Run** (`min-instances: 0` scale-to-zero, HTTPS enforced natively, non-root container user).
- **Database**: **BigQuery** (`vehicle_id_demo.trade_in_inventory` and `vehicle_id_demo.sales_staff`) storing trade-in vehicle records keyed by registration number alongside registered sales staff.
- **Video Storage**: **Cloud Storage** (`gs://<YOUR_PROJECT_ID>-vehicle-videos/videos/<REGISTRATION>/...`) with Uniform Bucket-Level Access, Public Access Prevention, and a **7-day auto-delete lifecycle rule**.
- **AI Agents (`google-genai >= 2.30.1` + `gemini-3.8-flash`)**:
  1. **Vehicle Inspector Agent** ([`backend/agents/vehicle_inspector.py`](backend/agents/vehicle_inspector.py)): Modular skill pipeline:
     - *Skill 1 (`gemini_video_multimodal`)*: Multimodal video + audio extraction plus high-precision multi-frame OCR pass for registration plates, VIN, make, model, variant/trim, colour, interior/exterior rating (`1–10`) + condition notes, modifications, and odometer mileage.
     - *Skill 2 (`dvla_official_lookup`)*: Looks up the registration plate via the UK DVLA Vehicle Enquiry Service or Google Search grounding and **overrides video estimates with official DVLA data** while keeping video-detected trim/variant details.
     - *Skill 3 (`third_party_mot_lookup`)*: Checks MOT expiry and advisory summary.
     - *Skill 4 (`voice_dialogue_summariser`)*: Uses Web Audio bandpass filtering (`300Hz–3.4kHz`) + speech filtering to strip forecourt wind/noise and summarise spoken vehicle facts into bullet points.
  2. **Valuation Bot Agent** ([`backend/agents/valuation_bot.py`](backend/agents/valuation_bot.py)):
     - Uses Google Search grounding (or generic depreciation math offline) to gather UK market comparables (`For Sale` and `Recently Sold`) matching Make, Model, and ±10% age/mileage, calculating a suggested **Trade-In Offer** and **Retail Resale Value**.
- **Zero Hardcoded Secrets & Least-Privilege IAM**:
  - Uses Application Default Credentials (ADC) locally and a dedicated Service Account (`vehicle-id-sa`) on Cloud Run scoped to `roles/aiplatform.user`, `roles/bigquery.dataEditor`, `roles/bigquery.jobUser`, and `roles/storage.objectAdmin`.

---

## Setup & Deployment

### 1. Local Smoke Test (Using ADC)
```bash
python3 -m venv .venv
source .venv/bin/activate
pip install -r requirements.txt

gcloud auth application-default login
export GOOGLE_CLOUD_PROJECT="<YOUR_PROJECT_ID>"
uvicorn backend.main:app --host 0.0.0.0 --port 8080
```
Open `http://localhost:8080` and verify health at `http://localhost:8080/status`.

### 2. Deploy to Cloud Run
```bash
chmod +x scripts/setup.sh scripts/deploy.sh scripts/destroy.sh
./scripts/deploy.sh <YOUR_PROJECT_ID> us-central1
```

### 3. Teardown (Zero Stray Costs)
```bash
./scripts/destroy.sh <YOUR_PROJECT_ID> us-central1
```

---

## Mobile App & QR Code Phone Installation

### Quick Install (PWA / WebAPK)
1. Open the deployed web portal on desktop and click **Install on Phone (QR Code)** in the header bar.
2. Scan the QR code using your Android phone camera and open the link in Chrome.
3. Tap **Install App** in Google Chrome (or `⋮` -> **Add to Home screen**) to install it directly onto your home screen with rear camera recording and gallery upload support.

### Native Android Studio Project (`android/`)
For MDM distribution or custom `.apk`/`.aab` builds, a Kotlin WebView wrapper project is included in [`android/`](android/):
- **Package**: `com.cymbal.vehicleid`
- **Permissions**: Camera (`CAMERA`), Microphone (`RECORD_AUDIO`), Media Storage (`READ_MEDIA_VIDEO`)
- **Configuration**: Set `APP_HOST` in [`MainActivity.kt`](android/app/src/main/java/com/cymbal/vehicleid/MainActivity.kt) and `android:host` in [`AndroidManifest.xml`](android/app/src/main/AndroidManifest.xml) to your deployed Cloud Run hostname before building with `./gradlew assembleDebug`.

---

## User Workflow

1. **Salesperson Setup**: Add sales staff directly via the **+ Add Salesperson** button in the header; staff persist to BigQuery so every trade-in is attributed cleanly.
2. **Step 1 — Capture or Select Video**: Record a live walkaround video or choose a saved video from device storage/gallery, optionally speaking notes or entering a registration plate hint.
3. **Step 2 & 3 — Inspection & Official DVLA Verification**: Review AI-extracted vehicle condition, modifications, and comments alongside official DVLA/MOT fields.
4. **Step 4 — Progressive Valuation & Save**: As soon as core vehicle details are confirmed, Valuation Bot retrieves UK market comparables and populates recommended **Trade-In Offer (£)** and **Estimated Resale (£)** before saving to BigQuery.
5. **Search Inventory**: Switch to the **Search Vehicle** tab to filter across database columns, price/mileage ranges, view live SQL queries, and toggle vehicles as **Sold**.
