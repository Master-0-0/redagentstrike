#!/bin/bash
# Stop only the services recorded by this checkout's start.sh.
set -euo pipefail
ROOT="$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")" && pwd)"
exec /bin/bash "$ROOT/start.sh" --stop
