' Silent launcher for the personal T3 Code build: starts the app with no
' visible terminal. The desktop shortcut points here; the .cmd launcher stays
' for terminal use. Shows a message only if the app fails to start.
Set sh = CreateObject("WScript.Shell")
sh.CurrentDirectory = "C:\Users\AlexAugust\Downloads\T3 Code Personal\apps\desktop"
exitCode = sh.Run("node scripts\start-electron.mjs", 0, True)
If exitCode <> 0 Then
  MsgBox "T3 Code failed to start. Run ""Update T3 Code (My Version).cmd"" in the project folder to rebuild, then try again.", 48, "T3 Code"
End If
