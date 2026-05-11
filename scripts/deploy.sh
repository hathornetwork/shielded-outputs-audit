#!/bin/bash

set -euo pipefail

# Check if site and command parameters are provided
if [ -z "${1:-}" ] || [ -z "${2:-}" ]; then
  echo "Usage: $0 <site> <command>"
  exit 1
fi

site=$1
command=$2

# Define environment variables for each site
case $site in
  production)
    S3_BUCKET=hathor-shielded-outputs-audit
    CLOUDFRONT_ID=E3BW0TQTWSIMPC
    ;;
  *)
    echo "Unknown site: $site"
    exit 1
    ;;
esac

export S3_BUCKET
export CLOUDFRONT_ID

case $command in
  build)
    echo "Building for site: $site"
    npm run build
    ;;
  sync)
    echo "Syncing for site: $site"
    aws s3 sync --delete ./dist/ s3://$S3_BUCKET
    ;;
  clear_cache)
    echo "Clearing CloudFront cache for site: $site"
    aws cloudfront create-invalidation --distribution-id $CLOUDFRONT_ID --paths "/index.html"
    ;;
  deploy)
    echo "Deploying for site: $site"
    aws s3 sync --delete ./dist/ s3://$S3_BUCKET
    aws cloudfront create-invalidation --distribution-id $CLOUDFRONT_ID --paths "/index.html"
    ;;
  *)
    echo "Unknown command: $command"
    exit 1
    ;;
esac
