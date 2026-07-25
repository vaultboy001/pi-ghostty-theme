# pi-ghostty-theme demo recording
# Requires: vhs (brew install vhs), ghostty on PATH fallback handled below.
# Record:  vhs assets/demo.tape
# Output:  assets/demo-src.mp4 (post-process to demo.gif / demo.mp4 with ffmpeg)

Output assets/demo-src.mp4

Set Shell "zsh"
Set FontSize 15
Set Width 1280
Set Height 800
Set Theme "GitHub Dark"
Set TypingSpeed 55ms

# --- setup (not recorded) ---
Hide
Type "export PATH=$PATH:/Applications/Ghostty.app/Contents/MacOS"
Enter
Type "export TERM_PROGRAM=ghostty"
Enter
Type "rm -f ~/.pi/agent/ghostty-theme.json"
Enter
Type "cd ~/workspaces/pi/pi-ghostty-theme"
Enter
Type "clear"
Enter
Show

# --- demo arc: launch -> open picker -> search -> preview -> apply -> status ---
Type "pi -e npm:pi-ghostty-theme"
Enter
Sleep 15s

Type "/ghostty-theme"
Sleep 600ms
Enter
Sleep 4s

Type "tokyo"
Sleep 3s

Down
Sleep 2500ms
Down
Sleep 2500ms

Enter
Sleep 3.5s
