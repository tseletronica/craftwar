#!/bin/sh
docker exec -i nations-db-backup sh -lc 'exec psql "$BACKUP_DATABASE_URL" -At -F "|"' < /tmp/online_players_probe.sql