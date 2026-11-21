// Opens a local spreadsheet document in a separate KOT service-IB session.
&AtClient
Procedure OnOpen(Cancel)
    Prefix = "KOTMxlViewer=";
    If Left(LaunchParameter, StrLen(Prefix)) <> Prefix Then
        Close();
        Return;
    EndIf;
    Reader = New JSONReader;
    Reader.OpenFile(Mid(LaunchParameter, StrLen(Prefix) + 1));
    Request = ReadJSON(Reader);
    Reader.Close();
    Result = New Structure("opened", False);
    Try
        Document = ReadDocumentOnServer(New BinaryData(Request.filePath));
        Document.Show(Request.filePath);
        Result.opened = True;
    Except
        Result.Insert("error", ErrorDescription());
    EndTry;
    Writer = New JSONWriter;
    Writer.OpenFile(Request.resultPath + ".tmp");
    WriteJSON(Writer, Result);
    Writer.Close();
    MoveFile(Request.resultPath + ".tmp", Request.resultPath);
    If Not Result.opened Then
        Exit(False);
    Else
        Close();
    EndIf;
EndProcedure

&AtServerNoContext
Function ReadDocumentOnServer(Data)
    TemporaryFile = GetTempFileName("mxl");
    Data.Write(TemporaryFile);
    Try
        Document = New SpreadsheetDocument;
        Document.Read(TemporaryFile);
    Except
        DeleteFiles(TemporaryFile);
        Raise;
    EndTry;
    DeleteFiles(TemporaryFile);
    Return Document;
EndFunction
