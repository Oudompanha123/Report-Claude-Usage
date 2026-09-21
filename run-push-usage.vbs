' Launches run-push-usage.cmd with no console window, so the twice-daily
' scheduled run never flashes a black box over whatever you are doing.
Dim fso, shell, here
Set fso = CreateObject("Scripting.FileSystemObject")
Set shell = CreateObject("WScript.Shell")
here = fso.GetParentFolderName(WScript.ScriptFullName)
Dim extra, i
extra = ""
For i = 0 To WScript.Arguments.Count - 1
  extra = extra & " " & WScript.Arguments(i)
Next
shell.Run """" & here & "\run-push-usage.cmd""" & extra, 0, False
