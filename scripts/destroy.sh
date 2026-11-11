#!/usr/bin/env bash
# Cymbal Auto Group — Vehicle ID Cleanup / Teardown Script
# Idempotently deletes Cloud Run service, Cloud Storage bucket, BigQuery dataset,
# and Service Account to prevent stray costs.
# Usage: ./scripts/destroy.sh [PROJECT_ID] [REGION]

set -euo pipefail

PROJECT_ID="${1:-${GOOGLE_CLOUD_PROJECT:-$(gcloud config get-value project 2>/dev/null || true)}}"
if [[ -z "${PROJECT_ID}" ]]; then
  echo "Usage: $0 <PROJECT_ID> [REGION] (or set GOOGLE_CLOUD_PROJECT / gcloud config project)" >&2
  exit 1
fi
REGION="${2:-${GOOGLE_CLOUD_REGION:-us-central1}}"
SERVICE_NAME="cymbal-vehicle-id"
SA_NAME="vehicle-id-sa"
SA_EMAIL="${SA_NAME}@${PROJECT_ID}.iam.gserviceaccount.com"
BUCKET_NAME="${PROJECT_ID}-vehicle-videos"
BQ_DATASET="vehicle_id_demo"

echo "==> [1/4] Deleting Cloud Run service ${SERVICE_NAME} in ${REGION} (if present)..."
if gcloud run services describe "${SERVICE_NAME}" --region="${REGION}" --project="${PROJECT_ID}" --quiet >/dev/null 2>&1; then
  gcloud run services delete "${SERVICE_NAME}" \
    --region="${REGION}" \
    --project="${PROJECT_ID}" \
    --quiet
fi

echo "==> [2/4] Deleting Cloud Storage bucket gs://${BUCKET_NAME} (if present)..."
if gcloud storage buckets describe "gs://${BUCKET_NAME}" --project="${PROJECT_ID}" --quiet >/dev/null 2>&1; then
  gcloud storage rm --recursive "gs://${BUCKET_NAME}" --project="${PROJECT_ID}" --quiet || true
fi

echo "==> [3/4] Deleting BigQuery dataset ${PROJECT_ID}:${BQ_DATASET} (if present)..."
bq rm -r -f -d "${PROJECT_ID}:${BQ_DATASET}" 2>/dev/null || true

echo "==> [4/4] Deleting demo Service Account ${SA_EMAIL} (if present)..."
if gcloud iam service-accounts describe "${SA_EMAIL}" --project="${PROJECT_ID}" --quiet >/dev/null 2>&1; then
  gcloud iam service-accounts delete "${SA_EMAIL}" --project="${PROJECT_ID}" --quiet
fi

echo "✅ All Cymbal Vehicle ID demo resources cleaned up for project ${PROJECT_ID}."
