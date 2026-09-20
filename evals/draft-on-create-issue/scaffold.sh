#!/usr/bin/env bash
# The eval runner invokes a scaffold with `bash <path>`; the work is in scaffold.js.
exec node "$(dirname "$0")/scaffold.js"
