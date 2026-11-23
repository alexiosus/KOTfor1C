&After("ПриНачалеРаботыСистемы")
Procedure KOTVW_OnStart()
    Parts = StrSplit(LaunchParameter, ";", False);
    If Parts.Find("runMcp") = Undefined Then
        Return;
    EndIf;
    For Each Part In Parts Do
        If Left(Part, 8) <> "mcpPort=" Then
            Continue;
        EndIf;
        Port = Mid(Part, 9);
        If StrLen(Port) < 1 Or StrLen(Port) > 5 Then
            Return;
        EndIf;
        For Position = 1 To StrLen(Port) Do
            If StrFind("0123456789", Mid(Port, Position, 1)) = 0 Then
                Return;
            EndIf;
        EndDo;
        ClientApplication.SetShortCaption("Vanessa MCP: " + Port);
        // 1C joins the short and full captions with a dot and no space.
        ClientApplication.SetCaption(" KOT");
        Return;
    EndDo;
EndProcedure
