#!/usr/bin/env bash
# Cymbal Auto Group — Vehicle ID Setup Script
# Enables required GCP APIs, creates a dedicated least-privilege Service Account,
# provisions the Cloud Storage bucket with a 7-day auto-delete lifecycle policy,
# and initializes the BigQuery dataset and empty tables (vehicles & sales staff).

set -euo pipefail

PROJECT_ID="${1:-${GOOGLE_CLOUD_PROJECT:-$(gcloud config get-value project 2>/dev/null || true)}}"
if [[ -z "${PROJECT_ID}" ]]; then
  echo "Usage: $0 <PROJECT_ID> [REGION] (or set GOOGLE_CLOUD_PROJECT / gcloud config project)" >&2
  exit 1
fi
REGION="${2:-${GOOGLE_CLOUD_REGION:-us-central1}}"
SA_NAME="vehicle-id-sa"
SA_EMAIL="${SA_NAME}@${PROJECT_ID}.iam.gserviceaccount.com"
BUCKET_NAME="${PROJECT_ID}-vehicle-videos"
BQ_DATASET="vehicle_id_demo"
BQ_TABLE="trade_in_inventory"
BQ_USERS_TABLE="sales_staff"

echo "==> [1/5] Enabling required Google Cloud APIs in project: ${PROJECT_ID}"
gcloud services enable \
  run.googleapis.com \
  cloudbuild.googleapis.com \
  artifactregistry.googleapis.com \
  aiplatform.googleapis.com \
  bigquery.googleapis.com \
  storage.googleapis.com \
  --project="${PROJECT_ID}" \
  --quiet

echo "==> [2/5] Creating dedicated least-privilege Service Account: ${SA_EMAIL}"
if ! gcloud iam service-accounts describe "${SA_EMAIL}" --project="${PROJECT_ID}" --quiet >/dev/null 2>&1; then
  gcloud iam service-accounts create "${SA_NAME}" \
    --display-name="Cymbal Vehicle ID Demo Service Account" \
    --description="Least-privilege runtime identity for Cloud Run Vehicle ID demo" \
    --project="${PROJECT_ID}" \
    --quiet
fi

echo "==> [3/5] Granting least-privilege IAM roles (Vertex AI, BigQuery, Cloud Storage)"
for ROLE in \
  "roles/aiplatform.user" \
  "roles/bigquery.dataEditor" \
  "roles/bigquery.jobUser" \
  "roles/storage.objectAdmin"; do
  gcloud projects add-iam-policy-binding "${PROJECT_ID}" \
    --member="serviceAccount:${SA_EMAIL}" \
    --role="${ROLE}" \
    --condition=None \
    --quiet >/dev/null
done

PROJECT_NUMBER="$(gcloud projects describe "${PROJECT_ID}" --format="value(projectNumber)" --quiet)"
COMPUTE_SA="${PROJECT_NUMBER}-compute@developer.gserviceaccount.com"
for BUILD_ROLE in \
  "roles/cloudbuild.builds.builder" \
  "roles/storage.objectAdmin" \
  "roles/logging.logWriter" \
  "roles/artifactregistry.writer"; do
  gcloud projects add-iam-policy-binding "${PROJECT_ID}" \
    --member="serviceAccount:${COMPUTE_SA}" \
    --role="${BUILD_ROLE}" \
    --condition=None \
    --quiet >/dev/null
done

echo "==> [4/5] Provisioning Cloud Storage bucket gs://${BUCKET_NAME} with 7-day auto-delete lifecycle"
LIFECYCLE_FILE="$(mktemp)"
cat > "${LIFECYCLE_FILE}" <<'EOF'
{
  "rule": [
    {
      "action": {"type": "Delete"},
      "condition": {"age": 7}
    }
  ]
}
EOF

if ! gcloud storage buckets describe "gs://${BUCKET_NAME}" --project="${PROJECT_ID}" --quiet >/dev/null 2>&1; then
  gcloud storage buckets create "gs://${BUCKET_NAME}" \
    --location="${REGION}" \
    --uniform-bucket-level-access \
    --public-access-prevention \
    --lifecycle-file="${LIFECYCLE_FILE}" \
    --project="${PROJECT_ID}" \
    --quiet
fi
rm -f "${LIFECYCLE_FILE}"

echo "==> [5/5] Initializing BigQuery dataset (${BQ_DATASET}.${BQ_TABLE} and ${BQ_DATASET}.${BQ_USERS_TABLE})"
export GOOGLE_CLOUD_PROJECT="${PROJECT_ID}"
export GOOGLE_CLOUD_REGION="${REGION}"
export GCS_BUCKET="${BUCKET_NAME}"
if [ -x ".venv/bin/python" ]; then
  .venv/bin/python -c "from backend.storage import VehicleStorageManager; print(VehicleStorageManager().initialize_cloud_resources())"
else
  python3 -c "from backend.storage import VehicleStorageManager; print(VehicleStorageManager().initialize_cloud_resources())"
fi

echo "==> Setup complete for project ${PROJECT_ID}."
