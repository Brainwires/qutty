# qutty.bash: the shell is the harness. In a Qutty tile, a line that starts with the prefix and a
# space (default ", ") is a request to the model instead of a command:
#
#   , list the five biggest files here      <Enter>
#
# The explanation prints above the prompt and the proposed command lands in the edit buffer.
# Nothing runs until you press Enter on it yourself. `, next` continues (the shell session is the
# conversation: the hub remembers the earlier requests, and the plugin sends the commands you
# ran since, with their exit status and folder). `, help` lists the other words (inbox, say, to,
# reset). Every other line, including one that starts with the prefix but no space (`,foo`) or
# contains commas, runs as it always did.
#
# Installed to ~/.qutty/shell/ by Qutty; sourced from ~/.bashrc by Settings → Agent integration
# (or by hand: `source ~/.qutty/shell/qutty.bash`). Outside a Qutty tile it does nothing.
#
# How (bash 4 and later): Enter (C-m) becomes a two-key macro. The first key runs a `bind -x`
# function that reads the line (READLINE_LINE) before bash parses it, so quotes, globs and `!`
# in a request are never interpreted. For an ordinary line it binds the second key to
# accept-line and the line runs as usual; for a request it binds the second key to a redraw,
# sends the request to `qutty-agent` (the explanation prints on the terminal) and puts the
# proposed command into READLINE_LINE. C-j still accepts any line as it is.
#
# Bash 3.2 (macOS's /bin/bash) has no READLINE_LINE: there the prefix is a function, the request
# is read back from the history (raw, before globbing), and the proposed command is put into
# the history instead: press Up to edit it. Quotes in a request must be balanced there.
#
# Recent commands come from a PROMPT_COMMAND hook (the last history entry and its exit status;
# the last 10 are kept). It runs first and leaves $? as it found it.
#
# New hub messages are announced above the prompt (`📬 2 new messages — , inbox`) when their
# count rose since the last check: `qutty-agent --unread` asks the tile's socket, at most every
# QUTTY_AGENT_NOTIFY_EVERY seconds (default 5; 0: every prompt; off: never), silently skipped when
# the hub does not answer within a second.
#
# Shell integration marks (OSC 133, lib/shell-marks.ts): bash has no hook before a command runs,
# so the same PROMPT_COMMAND hook sends, for each new command, `133;D;<exit>` with its line and
# how long it ran (from the history entry's timestamp), then `133;A` as the prompt starts. Qutty
# learns each command's exit status and duration from it (Loopy's reactions, Settings →
# Companion). They are invisible; QUTTY_SHELL_MARKS=off leaves them out.
#
# Settings (environment): QUTTY_AGENT_PREFIX (default ,), QUTTY_AGENT_BRAIN (auto | claude |
# ollama), QUTTY_AGENT_MODEL, QUTTY_AGENT_BIN (the qutty-agent to use), QUTTY_AGENT_NOTIFY_EVERY,
# QUTTY_SHELL_MARKS.

case $- in *i*) ;; *) return 0 ;; esac
[ -n "${QUTTY_SOCK-}${QUTTY_HUB-}" ] || return 0
[ -z "${__qutty_shell_loaded-}" ] || return 0
__qutty_shell_loaded=1

QUTTY_AGENT_PREFIX=${QUTTY_AGENT_PREFIX-,}
# qutty-agent sits in ../bin beside this file (~/.qutty/bin), else on PATH.
if [ -n "${QUTTY_AGENT_BIN-}" ]; then
  __qutty_agent=$QUTTY_AGENT_BIN
else
  __qutty_agent="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." 2>/dev/null && pwd)/bin/qutty-agent"
  [ -x "$__qutty_agent" ] || __qutty_agent=qutty-agent
fi

# Recent commands: "<exit>\t<folder>\t<line>", oldest first.
__qutty_history=()
__qutty_last_hist=""
__qutty_seen_prompt=""
__qutty_skip_hist=""
# The unread count at the last check, and when (in $SECONDS) that was.
__qutty_unread=0
__qutty_unread_at=-1000

# Announce new hub messages when their count rose (at most every QUTTY_AGENT_NOTIFY_EVERY s).
__qutty_notify() {
  local every=${QUTTY_AGENT_NOTIFY_EVERY-5} n s=s
  [ "$every" != off ] || return 0
  case "$every" in '' | *[!0-9]*) every=5 ;; esac
  [ $((SECONDS - __qutty_unread_at)) -ge "$every" ] || return 0
  __qutty_unread_at=$SECONDS
  n=$("$__qutty_agent" --unread 2>/dev/null) || return 0
  case "$n" in '' | *[!0-9]*) return 0 ;; esac
  if [ "$n" -gt "$__qutty_unread" ]; then
    [ "$n" -ne 1 ] || s=""
    printf '\033[2m📬 %s new message%s — %s inbox\033[0m\n' "$n" "$s" "$QUTTY_AGENT_PREFIX"
  fi
  __qutty_unread=$n
}

# The OSC 133 marks for the command that just ended (exit $1, its line $2; none when $2 is
# empty) and the prompt. The duration comes from the history entry's timestamp, left out when
# the entry has none.
__qutty_marks() {
  [ "${QUTTY_SHELL_MARKS-}" != off ] || return 0
  local entry now line=$2 took="" re='^ *[0-9]+[*]? +([0-9]+) '
  if [ -n "$line" ]; then
    entry=$(HISTTIMEFORMAT='%s ' builtin history 1)
    if [[ $entry =~ $re ]]; then
      now=${EPOCHSECONDS:-$(date +%s)}
      took=";duration=$((now - BASH_REMATCH[1]))"
    fi
    line=${line//%/%25}
    line=${line//;/%3B}
    line=${line//[[:cntrl:]]/ }
    printf '\033]133;D;%s;cmdline_url=%s%s\007' "$1" "$line" "$took"
  fi
  printf '\033]133;A\007'
}

__qutty_precmd() {
  local exit_status=$? entry num="" line="" re='^ *([0-9]+)[*]? +(.*)$' ran=""
  entry=$(HISTTIMEFORMAT='' builtin history 1)
  if [[ $entry =~ $re ]]; then
    num=${BASH_REMATCH[1]}
    line=${BASH_REMATCH[2]}
  fi
  # The first prompt sees the history file's last entry, not a command of this session; a
  # proposal put into the history (bash 3.2) was not run.
  if [ -n "$__qutty_seen_prompt" ] && [ -z "$__qutty_skip_hist" ] && [ -n "$num" ] &&
    [ "$num" != "$__qutty_last_hist" ] && [ "${line#"$QUTTY_AGENT_PREFIX "}" = "$line" ]; then
    line=${line//$'\n'/ }
    line=${line//$'\t'/ }
    __qutty_history+=("$exit_status"$'\t'"$PWD"$'\t'"$line")
    [ "${#__qutty_history[@]}" -le 10 ] || __qutty_history=("${__qutty_history[@]:1}")
    ran=$line
  fi
  __qutty_marks "$exit_status" "$ran"
  __qutty_seen_prompt=1
  __qutty_skip_hist=""
  __qutty_last_hist=$num
  __qutty_notify
  return $exit_status
}

case "$(declare -p PROMPT_COMMAND 2>/dev/null)" in
  "declare -a"*) PROMPT_COMMAND=(__qutty_precmd "${PROMPT_COMMAND[@]}") ;;
  *) PROMPT_COMMAND="__qutty_precmd${PROMPT_COMMAND:+;$PROMPT_COMMAND}" ;;
esac

# Ask: print the explanation, the proposed command on stdout. $1: the request.
__qutty_ask() {
  local h
  for h in "${__qutty_history[@]}"; do printf '%s\n' "$h"; done |
    "$__qutty_agent" --shell bash -- "$1"
}

if [ "${BASH_VERSINFO[0]}" -ge 4 ]; then
  __qutty_enter() {
    local prefix=$QUTTY_AGENT_PREFIX line proposal
    if [ -z "$prefix" ] || [ "${READLINE_LINE#"$prefix "}" = "$READLINE_LINE" ]; then
      bind '"\C-x\C-_A": accept-line'
      return 0
    fi
    # The macro's second key: nothing to accept this time.
    bind '"\C-x\C-_A": redraw-current-line'
    line=$READLINE_LINE
    history -s -- "$line"
    # Bash 5.1 and later clear the typed line before a bind -x command runs: show it again.
    if [ "${BASH_VERSINFO[0]}" -gt 5 ] ||
      { [ "${BASH_VERSINFO[0]}" -eq 5 ] && [ "${BASH_VERSINFO[1]}" -ge 1 ]; }; then
      printf '%s%s\n' "${PS1@P}" "$line"
    fi
    # `, inbox` reads them all: a message after it is new again.
    [ "${line#"$prefix "}" != inbox ] || __qutty_unread=0
    if proposal=$(__qutty_ask "${line#"$prefix "}"); then
      READLINE_LINE=$proposal
    fi
    READLINE_POINT=${#READLINE_LINE}
  }
  for __qutty_km in emacs vi-insert; do
    bind -m "$__qutty_km" -x '"\C-x\C-_Q": __qutty_enter'
    bind -m "$__qutty_km" '"\C-x\C-_A": accept-line'
    bind -m "$__qutty_km" '"\C-m": "\C-x\C-_Q\C-x\C-_A"'
  done
  unset __qutty_km
elif [ -n "$QUTTY_AGENT_PREFIX" ] && [ -z "${QUTTY_AGENT_PREFIX//[A-Za-z0-9_,.:@%+-]/}" ]; then
  __qutty_comma() {
    local prefix=$QUTTY_AGENT_PREFIX line proposal
    # The line as typed (before quote removal and globbing).
    line=$(HISTTIMEFORMAT='' builtin fc -ln -1 2>/dev/null)
    line=${line#"${line%%[! $'\t']*}"}
    case "$line" in
      "$prefix "*) line=${line#"$prefix "} ;;
      *) line="$*" ;;
    esac
    [ "$line" != inbox ] || __qutty_unread=0
    if proposal=$(__qutty_ask "$line") && [ -n "$proposal" ]; then
      history -s -- "$proposal"
      __qutty_skip_hist=1
      printf '\033[2m(press Up to edit the command)\033[0m\n' >&2
    fi
  }
  eval "function $QUTTY_AGENT_PREFIX { __qutty_comma \"\$@\"; }"
fi
