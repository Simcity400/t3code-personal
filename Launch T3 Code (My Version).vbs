' Compatibility launcher for the one installed personal T3 Code app.
Set fso = CreateObject("Scripting.FileSystemObject")
Set sh = CreateObject("WScript.Shell")

appExe = sh.ExpandEnvironmentStrings("%LOCALAPPDATA%") & _
  "\Programs\t3code\T3 Code (Nightly).exe"

If Not fso.FileExists(appExe) Then
  MsgBox "Your personal T3 Code app is not installed.", 48, "T3 Code"
  WScript.Quit 1
End If

sh.Run Chr(34) & appExe & Chr(34), 0, False
