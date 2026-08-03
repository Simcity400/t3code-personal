' Silent launcher for the personal T3 Code build: starts the app with no
' visible terminal. The desktop shortcut points here; the .cmd launcher stays
' for terminal use. Paths derive from this script's location so the same file
' works on any machine that clones the repo.
'
' Exit 130 means another instance holds the shared single-instance lock. On
' this machine that is usually the broken official install sitting windowless
' in the background (its backend cannot boot), so clear it and retry once.
' If the lock holder was this build itself, its window has been focused and
' there is nothing to do.
Set fso = CreateObject("Scripting.FileSystemObject")
repoRoot = fso.GetParentFolderName(WScript.ScriptFullName)
Set sh = CreateObject("WScript.Shell")
sh.CurrentDirectory = fso.BuildPath(repoRoot, "apps\desktop")

exitCode = sh.Run("node scripts\start-electron.mjs", 0, True)

If exitCode = 130 Then
  Set wmi = GetObject("winmgmts:root\cimv2")
  Set officialProcs = wmi.ExecQuery("SELECT * FROM Win32_Process WHERE Name = 'T3 Code (Nightly).exe'")
  killed = 0
  For Each p In officialProcs
    On Error Resume Next
    p.Terminate
    On Error GoTo 0
    killed = killed + 1
  Next
  If killed > 0 Then
    WScript.Sleep 2000
    exitCode = sh.Run("node scripts\start-electron.mjs", 0, True)
  End If
End If

If exitCode <> 0 And exitCode <> 130 Then
  MsgBox "T3 Code failed to start. Run ""Update T3 Code (My Version).cmd"" in the project folder to rebuild, then try again.", 48, "T3 Code"
End If
