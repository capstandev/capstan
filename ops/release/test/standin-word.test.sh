#!/bin/bash
# The stand-in forbidden word of the public-sync tests and the sandboxes is built at run time (two parts joined).
# The real public sync refuses a tree that still holds a forbidden word, so the word must never be written whole in
# any tracked file: one literal anywhere makes every sandbox copy of this repo fail. This guard keeps it that way.
. "$(dirname "$0")/lib.sh"
WORD="zebra""corn"

t_no_tracked_file_holds_the_word() {
  local top hits
  if top=$(git -C "$T_ROOT" rev-parse --show-toplevel 2>/dev/null); then
    hits=$(git -C "$top" grep -I -i -l -F -e "$WORD" -- . 2>/dev/null || true)
  else
    hits=$(grep -r -I -i -l -F -e "$WORD" "$T_ROOT" 2>/dev/null || true)   # no git here (a mounted copy): scan the runner tree
  fi
  [ -z "$hits" ] || fail "the stand-in forbidden word is written whole in: $(printf '%s' "$hits" | tr '\n' ' ')"
}

t_the_three_harnesses_build_the_same_word() {
  local f n
  for f in public-sync.test.sh sandbox/inside.sh sandbox/stress72.sh; do
    n=$(grep -c -F 'WORD="zebra""corn"' "$T_ROOT/test/$f" || true)
    assert_eq "$n" 1 "$f must build the word from the same two parts"
  done
}

t_guard_sees_a_planted_literal() {
  local d; d=$(mktemp -d "${TMPDIR:-/tmp}/rr-test.XXXXXX")
  printf 'x %s y\n' "$WORD" > "$d/planted.txt"
  local hits; hits=$(grep -r -I -i -l -F -e "$WORD" "$d" || true)
  rm -rf "$d"
  assert_contains "$hits" "planted.txt" "the scan must find a whole word"
}

run_tests "$0"
