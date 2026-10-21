// Used only by KOT preparation in its own service IB or a disposable template IB.
// Only client_mcp 0.6.6 is changed; unsafe-action protection is preserved.
&AtClient
Procedure OnOpen(Cancel)
    Parts = StrSplit(StrReplace(LaunchParameter, "KOTMcpPreparation=", ""), "|", False);
    If Parts.Count() <> 2 Then
        Close();
        Return;
    EndIf;
    Mode = Parts[0];
    ResultPath = Parts[1];
    Result = New Structure;
    Try
        If Mode <> "KOTMcpConfigure" And Mode <> "KOTMcpVerify" Then
            Raise "Invalid KOT MCP preparation mode";
        EndIf;
        Result = ConfigureOnServer(Mode = "KOTMcpConfigure");
    Except
        Result.Insert("error", ErrorDescription());
    EndTry;
    Writer = New JSONWriter;
    Writer.OpenFile(ResultPath);
    WriteJSON(Writer, Result);
    Writer.Close();
    Exit(False);
EndProcedure

&AtServerNoContext
Function ConfigureOnServer(Configure)
    If UserName() <> "KOTStartupService" Then
        Raise "KOT service user required";
    EndIf;
    For Each ExtensionItem In ConfigurationExtensions.Get() Do
        If ExtensionItem.Name <> "client_mcp" Then
            Continue;
        EndIf;
        If ExtensionItem.Version <> "0.6.6" Then
            Raise "Unexpected client_mcp version";
        EndIf;
        Protection = ExtensionItem.ЗащитаОтОпасныхДействий.ПредупреждатьОбОпасныхДействиях;
        If Configure And ExtensionItem.SafeMode Then
            ExtensionItem.SafeMode = False;
            ExtensionItem.Write();
        EndIf;
        // Re-read persisted settings instead of reporting the in-memory assignment.
        For Each Saved In ConfigurationExtensions.Get() Do
            If Saved.Name = "client_mcp" Then
                If Saved.SafeMode Or Not Saved.Active Or Saved.ЗащитаОтОпасныхДействий.ПредупреждатьОбОпасныхДействиях <> Protection Then
                    Raise "MCP settings not persisted";
                EndIf;
                Return New Structure("name,version,safeMode,unsafeActionProtection,active", Saved.Name, Saved.Version, Saved.SafeMode, Saved.ЗащитаОтОпасныхДействий.ПредупреждатьОбОпасныхДействиях, Saved.Active);
            EndIf;
        EndDo;
    EndDo;
    Raise "Pinned client_mcp extension not installed";
EndFunction
