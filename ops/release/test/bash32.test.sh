#!/bin/bash
# Every script parses and runs under macOS bash 3.2 (the owner runs some of them on the Mac) and avoids bash 4 syntax.
. "$(dirname "$0")/lib.sh"

files() { find "$T_ROOT" -name '*.sh' -not -path '*/node_modules/*' -not -name bash32.test.sh; }
code_only() { grep -vE '^[^:]+:[0-9]+:[[:space:]]*#' || true; }

t_no_bash4_constructs() {
  bad=$(files | xargs grep -nE 'mapfile|readarray|declare -A|local -n|\$\{[A-Za-z_]+(,,|\^\^)\}|\[-1\]|&>>|\|&|coproc|printf -v [a-z_]+ .%\(|\bwait -n\b' | code_only)
  assert_eq "$bad" "" "bash 4 only syntax"
}

t_every_script_parses_with_bin_bash() {
  for f in $(files); do /bin/bash -n "$f" || fail "$f does not parse"; done
}

t_entry_points_are_bash_and_executable() {
  for f in "$T_ROOT"/bin/*.sh "$T_ROOT"/install.sh; do
    [ -x "$f" ] || fail "$f is not executable"
    assert_eq "$(head -n 1 "$f")" "#!/bin/bash" "$f shebang"
  done
}

t_no_pkill_or_pattern_kill() {
  bad=$(files | xargs grep -nE '\bpkill\b|killall|kill -[0-9A-Z]+ +\$\(pgrep' | code_only)
  assert_eq "$bad" "" "pattern kills"
}

t_no_runner_file_is_git_ignored() {
  # macOS core.ignorecase once hid bin/resume.sh behind the root .gitignore's RESUME* rule
  if ! git -C "$T_ROOT" rev-parse --git-dir > /dev/null 2>&1; then return 0; fi
  hidden=$(cd "$T_ROOT" && find bin lib test systemd sudoers etc install.sh README.md npm/*/package.json npm/*/*.mjs npm/*/*.ts npm/*/README.md npm/*/server.json -type f 2>/dev/null | git check-ignore --stdin || true)
  assert_eq "$hidden" "" "ignored runner files"
}

run_tests "$0"
