#!/bin/sh
# Starts the virtual screen for the browser's window, at an ordinary laptop size, then the
# price-checker. (Not xvfb-run: it waits for a signal that never arrives when it's the
# container's first process, so the price-checker never started.)
# A restarted container keeps /tmp, so clear the last run's lock first.
rm -f /tmp/.X99-lock /tmp/.X11-unix/X99
Xvfb :99 -screen 0 1366x900x24 -nolisten tcp &
export DISPLAY=:99
exec node server.js
