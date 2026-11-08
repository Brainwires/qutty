# qutty.zsh: the shell is the harness. In a Qutty tile, a line that starts with the prefix and a
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
# Installed to ~/.qutty/shell/ by Qutty; sourced from ~/.zshrc by Settings → Agent integration
# (or by hand: `source ~/.qutty/shell/qutty.zsh`). Outside a Qutty tile it does nothing.
#
# How: accept-line (the widget Enter runs) is wrapped. When the buffer starts with the prefix and
# a space, the widget adds the line to the history, sends it to `qutty-agent` (which prints the
# explanation on the terminal and the command on stdout) and sets BUFFER to the command, instead
# of accepting the line. Recent commands come from preexec / precmd hooks (the last 10).
#
# New hub messages are announced above the prompt (`📬 2 new messages — , inbox`) when their
# count rose since the last check: `qutty-agent --unread` asks the tile's socket, at most every
# QUTTY_AGENT_NOTIFY_EVERY seconds (default 5; 0: every prompt; off: never), silently skipped when
# the hub does not answer within a second.
#
# Shell integration marks (OSC 133, lib/shell-marks.ts): `133;C` with the command line when a
# command starts (preexec), `133;D;<exit>` when it ends and `133;A` as the prompt starts (precmd),
# so Qutty knows each command's exit status and how long it ran (Loopy's reactions, Settings →
# Companion). They are invisible; QUTTY_SHELL_MARKS=off leaves them out.
#
# Settings (environment): QUTTY_AGENT_PREFIX (default ,), QUTTY_AGENT_BRAIN (auto | claude |
# ollama), QUTTY_AGENT_MODEL, QUTTY_AGENT_BIN (the qutty-agent to use), QUTTY_AGENT_NOTIFY_EVERY,
# QUTTY_SHELL_MARKS.

[[ -o interactive ]] || return 0
[[ -n ${QUTTY_SOCK-}${QUTTY_HUB-} ]] || return 0
(( ${+__qutty_shell_loaded} )) && return 0
typeset -g __qutty_shell_loaded=1

typeset -g QUTTY_AGENT_PREFIX=${QUTTY_AGENT_PREFIX-,}
# qutty-agent sits in ../bin beside this file (~/.qutty/bin), else on PATH.
typeset -g __qutty_agent=${QUTTY_AGENT_BIN:-${${(%):-%x}:A:h:h}/bin/qutty-agent}
[[ -x $__qutty_agent ]] || __qutty_agent=qutty-agent

# Recent commands: "<exit>\t<folder>\t<line>", oldest first.
typeset -ga __qutty_history
typeset -g __qutty_cmd="" __qutty_cmd_dir=""
# The unread count at the last check, and when (in $SECONDS) that was.
typeset -gi __qutty_unread=0 __qutty_unread_at=-1000

# Announce new hub messages when their count rose (at most every QUTTY_AGENT_NOTIFY_EVERY s).
__qutty_notify() {
  emulate -L zsh
  local every=${QUTTY_AGENT_NOTIFY_EVERY-5} n s=s
  [[ $every == off ]] && return 0
  [[ $every == <-> ]] || every=5
  (( SECONDS - __qutty_unread_at >= every )) || return 0
  __qutty_unread_at=$SECONDS
  n=$("$__qutty_agent" --unread 2>/dev/null) || return 0
  [[ $n == <-> ]] || return 0
  if (( n > __qutty_unread )); then
    (( n == 1 )) && s=""
    print -r -- $'\e[2m'"📬 $n new message$s — $QUTTY_AGENT_PREFIX inbox"$'\e[0m'
  fi
  __qutty_unread=$n
}

# An OSC 133 mark (`A`, `C;cmdline_url=…`, `D;<exit>`), unless QUTTY_SHELL_MARKS=off.
__qutty_mark() {
  [[ ${QUTTY_SHELL_MARKS-} == off ]] && return 0
  print -rn -- $'\e]133;'"$1"$'\a'
}

__qutty_preexec() {
  __qutty_cmd=${1//$'\n'/ }
  __qutty_cmd=${__qutty_cmd//$'\t'/ }
  __qutty_cmd_dir=$PWD
  # The line percent-escaped where it would end the mark (`%`, `;`), control characters dropped.
  local line=${__qutty_cmd//\%/%25}
  line=${line//;/%3B}
  __qutty_mark "C;cmdline_url=${line//[[:cntrl:]]/ }"
}

__qutty_precmd() {
  local exit_status=$?
  [[ -n $__qutty_cmd ]] && __qutty_mark "D;$exit_status"
  __qutty_mark A
  if [[ -n $__qutty_cmd ]]; then
    __qutty_history+=("$exit_status"$'\t'"$__qutty_cmd_dir"$'\t'"$__qutty_cmd")
    (( ${#__qutty_history} > 10 )) && shift __qutty_history
    __qutty_cmd=""
  fi
  __qutty_notify
  return $exit_status
}

autoload -Uz add-zsh-hook
add-zsh-hook preexec __qutty_preexec
# First, so it sees the command's exit status before another hook changes $?.
precmd_functions=(__qutty_precmd ${precmd_functions:#__qutty_precmd})

# Keep a widget someone else put on accept-line (zsh-autosuggestions, …) and call it for ordinary lines.
if [[ ${widgets[accept-line]-} == user:* ]]; then
  zle -A accept-line __qutty_orig_accept_line
else
  zle -A .accept-line __qutty_orig_accept_line
fi

__qutty_accept_line() {
  local prefix=$QUTTY_AGENT_PREFIX
  if [[ -z $prefix || $BUFFER != "$prefix "* ]]; then
    zle __qutty_orig_accept_line -- "$@"
    return
  fi
  emulate -L zsh
  local line=$BUFFER request=${BUFFER#"$prefix "} proposal
  print -rs -- "$line"
  # `, inbox` reads them all: a message after it is new again.
  [[ ${request// /} == inbox ]] && __qutty_unread=0
  # Move below the typed line (it stays on screen) and let the agent print there.
  zle -I
  print
  proposal=$(print -rl -- "${__qutty_history[@]}" | "$__qutty_agent" --shell zsh -- "$request")
  if (( $? == 0 )); then
    BUFFER=$proposal
  else
    BUFFER=$line
  fi
  CURSOR=${#BUFFER}
}
zle -N accept-line __qutty_accept_line
