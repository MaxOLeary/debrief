#!/bin/bash
# Add this block to your sketchybarrc, after $PLUGIN_DIR and colors.sh are set.
# Needs DebriefIcons.ttf in ~/Library/Fonts (sketchybar/icon/install.sh).
# Right-side items stack first-added = rightmost, so put this wherever you want
# it in that order.

sketchybar --add item center.notes right \
           --set center.notes icon="" \
                              icon.font="DebriefIcons:Regular:14.0" \
                              icon.color=$WHITE \
                              icon.drawing=on \
                              icon.padding_left=6 \
                              icon.padding_right=2 \
                              label.font="$FONT:Bold:12.0" \
                              label.padding_left=2 \
                              label.padding_right=6 \
                              label.drawing=off \
                              update_freq=1 \
                              script="$PLUGIN_DIR/debrief.sh" \
                              click_script="$PLUGIN_DIR/debrief_click.sh" \
           --subscribe center.notes debrief_changed
