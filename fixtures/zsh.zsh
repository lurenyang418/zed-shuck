#!/usr/bin/env zsh

typeset -a names=(one two)
for name in $names; do
  print "$name"
done
