; FoodMonsterPrint installer (Inno Setup 6.3 or newer).
; Build: node scripts/build-windows.mjs   (creates build\win\ and, on Windows, runs ISCC on this file)
;
; Silent install / update:
;   FoodMonsterPrint-Setup-x.y.z.exe /VERYSILENT /SUPPRESSMSGBOXES /NORESTART /SP- [/SERVER=https://...]
; /SERVER is used only on the first install (an existing config.json is never changed).

#define AppName "FoodMonsterPrint"
#ifndef AppVersion
  #define AppVersion "0.0.0"
#endif

[Setup]
AppId={{6D1F2A8E-3C4B-4E7A-9B21-5F0C8D7E4A13}
AppName={#AppName}
AppVersion={#AppVersion}
AppVerName={#AppName} {#AppVersion}
AppPublisher=FoodMonster
DefaultDirName={autopf}\{#AppName}
DisableDirPage=yes
DisableProgramGroupPage=yes
DisableReadyPage=no
PrivilegesRequired=admin
ArchitecturesAllowed=x64compatible
ArchitecturesInstallIn64BitMode=x64compatible
MinVersion=10.0
OutputDir=..\..\build\installer
OutputBaseFilename=FoodMonsterPrint-Setup-{#AppVersion}
Compression=lzma2
SolidCompression=yes
WizardStyle=modern
UninstallDisplayName={#AppName}
UninstallDisplayIcon={app}\node\node.exe
SetupLogging=yes
CloseApplications=no
RestartApplications=no

[Files]
Source: "..\..\build\win\*"; DestDir: "{app}"; Flags: ignoreversion recursesubdirs createallsubdirs

[Run]
Filename: "http://127.0.0.1:9123/"; Description: "Open the FoodMonsterPrint status page (to pair this PC)"; Flags: postinstall shellexec nowait skipifsilent

[Code]
const
  ProductionUrl = 'https://admin.foodmonster.asia';
  StagingUrl = 'https://staging.foodmonster.asia';

var
  ServerPage: TInputOptionWizardPage;
  CustomUrlPage: TInputQueryWizardPage;

function DataDir: String;
begin
  Result := ExpandConstant('{commonappdata}\{#AppName}');
end;

function ConfigExists: Boolean;
begin
  Result := FileExists(DataDir + '\config.json');
end;

function CmdServerUrl: String;
begin
  Result := Trim(ExpandConstant('{param:SERVER|}'));
end;

function ServiceExe: String;
begin
  Result := ExpandConstant('{app}\FoodMonsterPrint.exe');
end;

procedure RunHidden(const FileName, Params: String);
var
  Code: Integer;
begin
  if Exec(FileName, Params, '', SW_HIDE, ewWaitUntilTerminated, Code) then
    Log(Format('Ran "%s" %s -> exit %d', [FileName, Params, Code]))
  else
    Log(Format('Could not run "%s" %s (error %d)', [FileName, Params, Code]));
end;

function IsSafeUrl(const Url: String): Boolean;
begin
  Result := (Pos('https://', Lowercase(Url)) = 1) and (Pos('"', Url) = 0) and (Pos('\', Url) = 0) and (Pos(' ', Url) = 0);
end;

procedure InitializeWizard;
begin
  ServerPage := CreateInputOptionPage(wpWelcome,
    'Server', 'Which FoodMonster server should this PC print for?',
    'Choose Production for shops. Use Staging only for testing.', True, False);
  ServerPage.Add('Production (' + ProductionUrl + ')');
  ServerPage.Add('Staging (' + StagingUrl + ')');
  ServerPage.Add('Other address (type it on the next page)');
  ServerPage.SelectedValueIndex := 0;

  CustomUrlPage := CreateInputQueryPage(ServerPage.ID,
    'Server address', 'Type the server address', 'Example: https://admin.foodmonster.asia');
  CustomUrlPage.Add('Server URL:', False);
end;

function ShouldSkipPage(PageID: Integer): Boolean;
begin
  Result := False;
  { Upgrade (config.json exists) or /SERVER= given: do not ask. }
  if PageID = ServerPage.ID then
    Result := ConfigExists or (CmdServerUrl <> '');
  if PageID = CustomUrlPage.ID then
    Result := ConfigExists or (CmdServerUrl <> '') or (ServerPage.SelectedValueIndex <> 2);
end;

function NextButtonClick(CurPageID: Integer): Boolean;
begin
  Result := True;
  if (CurPageID = CustomUrlPage.ID) and not IsSafeUrl(Trim(CustomUrlPage.Values[0])) then
  begin
    MsgBox('The address must start with https:// (no spaces).', mbError, MB_OK);
    Result := False;
  end;
end;

function ChosenServerUrl: String;
begin
  if CmdServerUrl <> '' then
    Result := CmdServerUrl
  else if ServerPage.SelectedValueIndex = 1 then
    Result := StagingUrl
  else if ServerPage.SelectedValueIndex = 2 then
    Result := Trim(CustomUrlPage.Values[0])
  else
    Result := ProductionUrl;
end;

function InitializeSetup: Boolean;
begin
  Result := True;
  if (CmdServerUrl <> '') and not IsSafeUrl(CmdServerUrl) then
  begin
    SuppressibleMsgBox('/SERVER must be an https:// address.', mbError, MB_OK, IDOK);
    Result := False;
  end;
end;

{ Upgrade: stop and remove the old service BEFORE files are replaced (node.exe must not be in use). }
function PrepareToInstall(var NeedsRestart: Boolean): String;
begin
  Result := '';
  if FileExists(ServiceExe) then
  begin
    RunHidden(ServiceExe, 'stopwait');
    RunHidden(ServiceExe, 'uninstall');
    Sleep(1500);
  end;
end;

procedure WriteConfigIfMissing;
var
  Json: String;
begin
  if ConfigExists then
  begin
    Log('config.json exists, kept as it is.');
    exit;
  end;
  ForceDirectories(DataDir);
  Json := '{' + #13#10 +
          '  "serverUrl": "' + ChosenServerUrl + '",' + #13#10 +
          '  "deviceName": "' + GetComputerNameString + '"' + #13#10 +
          '}' + #13#10;
  if not SaveStringToFile(DataDir + '\config.json', Json, False) then
    Log('Could not write config.json');
end;

procedure CurStepChanged(CurStep: TSetupStep);
begin
  if CurStep = ssPostInstall then
  begin
    WriteConfigIfMissing;
    { The data folder holds the device token: only SYSTEM and Administrators may read it. }
    RunHidden(ExpandConstant('{sys}\icacls.exe'),
      '"' + DataDir + '" /inheritance:r /grant:r *S-1-5-18:(OI)(CI)F *S-1-5-32-544:(OI)(CI)F');
    RunHidden(ServiceExe, 'install');
    RunHidden(ServiceExe, 'start');
  end;
end;

procedure CurUninstallStepChanged(CurUninstallStep: TUninstallStep);
begin
  if CurUninstallStep = usUninstall then
  begin
    RunHidden(ServiceExe, 'stopwait');
    RunHidden(ServiceExe, 'uninstall');
  end;
  if CurUninstallStep = usPostUninstall then
  begin
    if (not UninstallSilent) and
       (MsgBox('Also delete the settings, the device token and the logs?' + #13#10 + DataDir + #13#10#13#10 +
               'Choose No if you will install FoodMonsterPrint on this PC again.',
               mbConfirmation, MB_YESNO or MB_DEFBUTTON2) = IDYES) then
      DelTree(DataDir, True, True, True);
  end;
end;
