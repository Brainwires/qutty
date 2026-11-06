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
# Settings (environment): QUTTY_AGENT_PREFIX (default ,), QUTTY_AGENT_BRAIN (auto | claude |
# ollama), QUTTY_AGENT_MODEL, QUTTY_AGENT_BIN (the qutty-agent to use).

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

__qutty_precmd() {
  local exit_status=$? entry num="" line="" re='^ *([0-9]+)[*]? +(.*)$'
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
  fi
  __qutty_seen_prompt=1
  __qutty_skip_hist=""
  __qutty_last_hist=$num
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
    if proposal=$(__qutty_ask "$line") && [ -n "$proposal" ]; then
      history -s -- "$proposal"
      __qutty_skip_hist=1
      printf '\033[2m(press Up to edit the command)\033[0m\n' >&2
    fi
  }
  eval "function $QUTTY_AGENT_PREFIX { __qutty_comma \"\$@\"; }"
fi
