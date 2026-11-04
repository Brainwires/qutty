# Security policy

Qutty runs your shell with your user's permissions, so security issues matter.
Please report them privately rather than in a public issue.

## Reporting a vulnerability

Use GitHub's
[private vulnerability reporting](https://github.com/Brainwires/qutty/security/advisories/new)
(Security tab → "Report a vulnerability"). Include what you found, how to
reproduce it, and which version and OS you used.

You'll get an acknowledgement within a few days. Once a fix is released, the
advisory is published with credit to you, unless you'd rather stay anonymous.

## Supported versions

Only the latest release gets security fixes.

## Release integrity

Release builds are signed with a Developer ID (Joshua Guyette, team
`WT957SC7MJ`) and notarized by Apple. Each `.dmg` has a `.sha256` file next to
it on the release page. To check an installed copy:

```sh
codesign --verify --deep --strict /Applications/Qutty.app
spctl -a -t exec -vv /Applications/Qutty.app   # "source=Notarized Developer ID"
```
