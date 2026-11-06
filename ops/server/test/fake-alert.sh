#!/bin/bash
# Test double for the ops alert hook: appends the event JSON to a file.
printf '%s\n' "$1" >> "${FAKE_ALERT_LOG:-/tmp/alerts.log}"
