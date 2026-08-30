#!/bin/sh
# Hermetic ssh double for the remote-sidebar e2e lane. The node runner passes
# the ssh argument list (target, remote command); the fixture recognizes the
# two commands the connect flow issues and answers them without a network:
#   - the daemon describe probe (a curl of the remote /api/host.describe)
#   - the installation-id read (cat of $SHRES_HOME/.anonymous-user-id)
# Any other argv exits nonzero, so an unexpected exec fails the lane loudly.
for arg in "$@"; do
  case "$arg" in
    *host.describe*)
      printf '%s' '{"result":{"ok":true,"value":{"version":"0.1.0-rc.5"}}}'
      exit 0
      ;;
    *anonymous-user-id*)
      printf '%s' '0123456789abcdef'
      exit 0
      ;;
  esac
done
echo "remote-sidebar ssh fixture: unexpected argv: $*" >&2
exit 255
