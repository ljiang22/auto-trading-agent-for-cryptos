# DocumentDB Migration Workspace

## Current State

- Cluster is provisioned in AWS.
- Direct local connectivity currently fails with `MongoServerSelectionError: Server selection timed out after 30000 ms`.
- Agent runtime already enters `documentdb` mode and attempts a real connection to the current target.
- Approved private access path is still pending for live validation from this workstation.
- Use this workspace to hold execution artifacts once that path is available.

## Target Amazon DocumentDB

- endpoint: `sentiedge-docdb.cluster-cxic6ggsmhb9.us-east-2.docdb.amazonaws.com:27017`
- port: `27017`
- username: `senti_doc_041226`
- target database: `elizaAgent`

## Workspace Layout

- `logs/` = `mongosh` and migration execution logs
- `reports/` = dry-run / live-run migration reports
- `tmp/` = temporary files generated during validation or migration steps

## Notes

- Store the downloaded CA bundle here when the approved access path is ready.
- Keep this workspace focused on AWS DocumentDB validation and SQLite migration execution only.
- Team lead or another access-holder should perform final live connectivity/data checks if this workstation remains outside the approved network path.
