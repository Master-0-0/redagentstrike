#!/bin/bash
set -uo pipefail
cd /app
mkdir -p /results
failed=0
run() {
  local name="$1"; shift
  "$@" >"/results/$name.log" 2>&1
  local result=$?
  echo "$name: exit=$result" | tee -a /results/status.txt
  if [ "$result" -ne 0 ]; then failed=1; fi
}
: >/results/status.txt
run environment bash -c 'cat /etc/os-release; uname -m; python --version; node --version; pnpm --version; /app/backend/.venv-mitm/bin/mitmdump --version'
run python-dependencies python -m pip freeze
run mitm-dependencies /app/backend/.venv-mitm/bin/pip freeze
run backend python -m pytest backend/tests -ra --junitxml=/results/backend.xml
for plugin in dsh-cairn-search dsh-intel dsh-findings; do
  run "$plugin" npm --prefix "$plugin" test
done
if [ -d /opt/linux-compat ]; then
  run runtime-smoke python /opt/linux-compat/runtime-smoke.py
  run sandbox-smoke node /opt/linux-compat/sandbox-smoke.mjs
  run harness-smoke bash /opt/linux-compat/harness-smoke.sh
fi
exit "$failed"
