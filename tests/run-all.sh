#!/bin/sh
# 跑全部回归用例。用法：sh tests/run-all.sh
cd "$(dirname "$0")"
fail=0
LOGDIR="${TMPDIR:-/tmp}/dafeiyu-tests.$$"
mkdir -p "$LOGDIR"
trap 'rm -rf "$LOGDIR"' EXIT
for f in regress2 jobflow edge banner2 hooks persist retry remount countcap caps tabs; do
  printf '%-10s ' "$f"
  if node "$f.js" > "$LOGDIR/$f.log" 2>&1; then
    tail -1 "$LOGDIR/$f.log"
  else
    echo "FAILED（日志在 $LOGDIR/$f.log）"
    fail=1
  fi
done
exit $fail
