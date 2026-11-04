// Windows meeting detector. Prints the same JSON lines as the Mac helper's `detect`
// command so server/detector.ts can notify and auto-stop. Audio capture itself is
// not done here: the Electron shell uses Chromium's WASAPI loopback.
//
//   acta-audio.exe detect [--interval S]
//   acta-audio.exe check | devices | request | events | capture
//   acta-audio.exe paste   (dictation: sends Ctrl+V to the focused window)
//   acta-audio.exe hotkey  (dictation: reports Ctrl+Win down/up as JSON lines)
#define WIN32_LEAN_AND_MEAN
#define NOMINMAX
#include <windows.h>
#include <initguid.h>
#include <mmdeviceapi.h>
#include <audiopolicy.h>
#include <tlhelp32.h>
#include <shellapi.h>

#include <stdio.h>
#include <string.h>

#include <algorithm>
#include <string>
#include <vector>

struct Meeting {
  std::string app;
  std::string id;
  std::string title;
};

static std::wstring lower(std::wstring s) {
  for (auto& c : s) c = (wchar_t)towlower(c);
  return s;
}

static bool has(const std::wstring& hay, const wchar_t* needle) {
  return lower(hay).find(lower(needle)) != std::wstring::npos;
}

static bool starts(const std::wstring& hay, const wchar_t* needle) {
  const std::wstring n = lower(needle);
  return lower(hay).compare(0, n.size(), n) == 0;
}

static std::string utf8(const std::wstring& w) {
  if (w.empty()) return "";
  int n = WideCharToMultiByte(CP_UTF8, 0, w.data(), (int)w.size(), nullptr, 0, nullptr, nullptr);
  if (n <= 0) return "";
  std::string s((size_t)n, '\0');
  WideCharToMultiByte(CP_UTF8, 0, w.data(), (int)w.size(), s.data(), n, nullptr, nullptr);
  return s;
}

static std::string jsonEscape(const std::string& s) {
  std::string o;
  o.reserve(s.size() + 8);
  for (unsigned char c : s) {
    if (c == '"' || c == '\\') {
      o.push_back('\\');
      o.push_back((char)c);
    } else if (c == '\n' || c == '\r' || c == '\t') {
      o += " ";
    } else if (c >= 0x20) {
      o.push_back((char)c);
    }
  }
  return o;
}

static std::wstring fileName(const std::wstring& path) {
  const auto p = path.find_last_of(L"\\/");
  return lower(p == std::wstring::npos ? path : path.substr(p + 1));
}

struct Proc {
  DWORD pid;
  std::wstring exe;
};

static std::vector<Proc> processes() {
  std::vector<Proc> out;
  HANDLE snap = CreateToolhelp32Snapshot(TH32CS_SNAPPROCESS, 0);
  if (snap == INVALID_HANDLE_VALUE) return out;
  PROCESSENTRY32W pe;
  pe.dwSize = sizeof(pe);
  if (Process32FirstW(snap, &pe)) {
    do {
      out.push_back({pe.th32ProcessID, fileName(pe.szExeFile)});
    } while (Process32NextW(snap, &pe));
  }
  CloseHandle(snap);
  return out;
}

struct WinHit {
  DWORD pid;
  std::wstring title;
};

static BOOL CALLBACK collectWindow(HWND hwnd, LPARAM lp) {
  if (!IsWindowVisible(hwnd)) return TRUE;
  const int len = GetWindowTextLengthW(hwnd);
  if (len <= 0) return TRUE;
  std::wstring title((size_t)len + 1, L'\0');
  const int got = GetWindowTextW(hwnd, title.data(), len + 1);
  if (got <= 0) return TRUE;
  title.resize((size_t)got);
  DWORD pid = 0;
  GetWindowThreadProcessId(hwnd, &pid);
  reinterpret_cast<std::vector<WinHit>*>(lp)->push_back({pid, title});
  return TRUE;
}

static bool isBrowser(const std::wstring& exe) {
  return exe == L"chrome.exe" || exe == L"msedge.exe" || exe == L"firefox.exe" || exe == L"brave.exe" ||
         exe == L"opera.exe" || exe == L"vivaldi.exe" || exe == L"chromium.exe";
}

static bool isZoom(const std::wstring& exe) { return exe == L"zoom.exe"; }

static bool isTeams(const std::wstring& exe) {
  return exe == L"ms-teams.exe" || exe == L"teams.exe" || exe == L"msteams.exe";
}

static bool isWebex(const std::wstring& exe) {
  return exe == L"ciscocollabhost.exe" || exe == L"webexhost.exe" || exe == L"atmgr.exe" || exe == L"webexmta.exe" ||
         exe == L"ciscowebexstart.exe";
}

static std::vector<Meeting> detectMeetings(const std::vector<Proc>& procs, const std::vector<WinHit>& wins) {
  std::vector<Meeting> out;
  auto seen = [&](const std::string& key) {
    for (const auto& m : out)
      if (m.app + m.title == key) return true;
    return false;
  };
  auto add = [&](const char* app, const std::wstring& exe, const std::wstring& title) {
    const std::string t = utf8(title);
    const std::string key = std::string(app) + t;
    if (seen(key)) return;
    out.push_back({app, utf8(exe), t});
  };

  for (const auto& w : wins) {
    std::wstring exe;
    for (const auto& p : procs)
      if (p.pid == w.pid) {
        exe = p.exe;
        break;
      }
    const std::wstring& t = w.title;
    if (isBrowser(exe)) {
      if (starts(t, L"Meet - ") || has(t, L"Google Meet") || has(t, L"meet.google.com")) add("Google Meet", exe, t);
      else if (has(t, L"Microsoft Teams") && (has(t, L"Meeting") || has(t, L"Reunión") || has(t, L"Call") || has(t, L"Llamada")))
        add("Microsoft Teams", exe, t);
      else if (has(t, L"Whereby")) add("Whereby", exe, t);
      else if (has(t, L"Riverside")) add("Riverside", exe, t);
      else if (has(t, L"Zoom Meeting") || (has(t, L"Zoom Workplace") && has(t, L"Meeting"))) add("Zoom", exe, t);
    } else if (isZoom(exe)) {
      if (t == L"Zoom Meeting" || t == L"Zoom Webinar" || starts(t, L"Zoom Meeting") || has(t, L"Reunión de Zoom"))
        add("Zoom", exe, t);
    } else if (isTeams(exe)) {
      if (has(t, L"Meeting") || has(t, L"Reunión") || has(t, L"Call") || has(t, L"Llamada") || has(t, L"Meet now"))
        add("Microsoft Teams", exe, t);
    } else if (exe == L"slack.exe") {
      if (has(t, L"huddle")) add("Slack", exe, t);
    } else if (isWebex(exe)) {
      if (has(t, L"Meeting") || has(t, L"Reunión") || has(t, L"Call") || has(t, L"Llamada") || has(t, L"Webex"))
        add("Webex", exe, t);
    }
  }

  // Same idea as the Mac helper when window titles are unavailable: Zoom or Teams running is enough.
  if (out.empty() && wins.empty()) {
    for (const auto& p : procs) {
      if (isZoom(p.exe)) add("Zoom", p.exe, L"");
      else if (isTeams(p.exe)) add("Microsoft Teams", p.exe, L"");
    }
  }
  return out;
}

static bool micInUse(bool* ok) {
  *ok = false;
  const HRESULT init = CoInitializeEx(nullptr, COINIT_MULTITHREADED);
  const bool uninit = init == S_OK || init == S_FALSE;
  if (FAILED(init) && init != RPC_E_CHANGED_MODE) return false;

  bool used = false;
  IMMDeviceEnumerator* enumerator = nullptr;
  HRESULT hr = CoCreateInstance(__uuidof(MMDeviceEnumerator), nullptr, CLSCTX_ALL, IID_PPV_ARGS(&enumerator));
  if (SUCCEEDED(hr) && enumerator) {
    const ERole roles[] = {eCommunications, eConsole};
    for (ERole role : roles) {
      IMMDevice* device = nullptr;
      if (FAILED(enumerator->GetDefaultAudioEndpoint(eCapture, role, &device)) || !device) continue;
      IAudioSessionManager2* manager = nullptr;
      hr = device->Activate(__uuidof(IAudioSessionManager2), CLSCTX_ALL, nullptr, (void**)&manager);
      device->Release();
      if (FAILED(hr) || !manager) continue;
      IAudioSessionEnumerator* sessions = nullptr;
      hr = manager->GetSessionEnumerator(&sessions);
      manager->Release();
      if (FAILED(hr) || !sessions) continue;
      *ok = true;
      int count = 0;
      sessions->GetCount(&count);
      for (int i = 0; i < count; i++) {
        IAudioSessionControl* ctrl = nullptr;
        if (FAILED(sessions->GetSession(i, &ctrl)) || !ctrl) continue;
        AudioSessionState state = AudioSessionStateInactive;
        ctrl->GetState(&state);
        IAudioSessionControl2* ctrl2 = nullptr;
        ctrl->QueryInterface(IID_PPV_ARGS(&ctrl2));
        DWORD pid = 0;
        HRESULT system = S_FALSE;
        if (ctrl2) {
          ctrl2->GetProcessId(&pid);
          system = ctrl2->IsSystemSoundsSession();
          ctrl2->Release();
        }
        ctrl->Release();
        if (state == AudioSessionStateActive && pid != 0 && pid != GetCurrentProcessId() && system != S_OK) used = true;
      }
      sessions->Release();
    }
    enumerator->Release();
  }
  if (uninit) CoUninitialize();
  return used;
}

static void printLine(const std::string& json) {
  fwrite(json.data(), 1, json.size(), stdout);
  fputc('\n', stdout);
  fflush(stdout);
}

static void printDetect() {
  const auto procs = processes();
  std::vector<WinHit> wins;
  EnumWindows(collectWindow, reinterpret_cast<LPARAM>(&wins));
  const auto meetings = detectMeetings(procs, wins);
  bool micOk = false;
  bool mic = micInUse(&micOk);
  if (!micOk) mic = !meetings.empty();
  std::string json = std::string("{\"micInUse\":") + (mic ? "true" : "false") + ",\"meetings\":[";
  for (size_t i = 0; i < meetings.size(); i++) {
    if (i) json += ',';
    json += "{\"app\":\"" + jsonEscape(meetings[i].app) + "\",\"bundleId\":\"" + jsonEscape(meetings[i].id) +
            "\",\"title\":\"" + jsonEscape(meetings[i].title) + "\"}";
  }
  json += "],\"permissions\":{\"screen\":\"not-used\",\"mic\":\"prompt\",\"calendar\":\"not-used\"}}";
  printLine(json);
}

// Dictation: the shell has already put the text on the clipboard. First let go of any
// modifier the user may still be holding from the shortcut (Shift+V would type a "V"),
// then press Ctrl+V in whatever window has the focus.
static void keyEvent(std::vector<INPUT>& in, WORD vk, bool up) {
  INPUT i = {};
  i.type = INPUT_KEYBOARD;
  i.ki.wVk = vk;
  i.ki.dwFlags = up ? KEYEVENTF_KEYUP : 0;
  if (vk == VK_RWIN || vk == VK_LWIN || vk == VK_RMENU || vk == VK_RCONTROL) i.ki.dwFlags |= KEYEVENTF_EXTENDEDKEY;
  in.push_back(i);
}

static int sendPaste() {
  std::vector<INPUT> in;
  const WORD held[] = { VK_LSHIFT, VK_RSHIFT, VK_LMENU, VK_RMENU, VK_LWIN, VK_RWIN, VK_LCONTROL, VK_RCONTROL };
  for (WORD vk : held) if (GetAsyncKeyState(vk) & 0x8000) keyEvent(in, vk, true);
  keyEvent(in, VK_CONTROL, false);
  keyEvent(in, 'V', false);
  keyEvent(in, 'V', true);
  keyEvent(in, VK_CONTROL, true);
  const UINT sent = SendInput((UINT)in.size(), in.data(), sizeof(INPUT));
  if (sent != in.size()) {
    fprintf(stderr, "SendInput: %lu\n", GetLastError());
    return 1;
  }
  printLine("{\"ok\":true}");
  return 0;
}

// Dictation hotkey made only of modifiers (Ctrl + Windows), which RegisterHotKey and
// Electron's globalShortcut can't express. A low-level keyboard hook prints:
//   {"hotkey":"down"}    Ctrl and Win are both held, nothing else pressed
//   {"hotkey":"up"}      one of them was released
//   {"hotkey":"cancel"}  another key joined (Ctrl+Win+D, Ctrl+Win+→…): leave it to Windows
// When the combo fires we inject an unassigned key so that letting go of Win does not
// open the Start menu.
static bool g_ctrl[2] = { false, false };
static bool g_win[2] = { false, false };
static bool g_active = false;   // combo is down and reported
static bool g_spoiled = false;  // another key was pressed during this combo

static void emitHotkey(const char* what) {
  printf("{\"hotkey\":\"%s\"}\n", what);
  fflush(stdout);
}

static void maskStartMenu() {
  INPUT in[2] = {};
  in[0].type = in[1].type = INPUT_KEYBOARD;
  in[0].ki.wVk = in[1].ki.wVk = 0xE8;  // unassigned virtual key
  in[1].ki.dwFlags = KEYEVENTF_KEYUP;
  SendInput(2, in, sizeof(INPUT));
}

static LRESULT CALLBACK hotkeyHook(int nCode, WPARAM wParam, LPARAM lParam) {
  if (nCode == HC_ACTION) {
    const KBDLLHOOKSTRUCT* k = (const KBDLLHOOKSTRUCT*)lParam;
    if (!(k->flags & LLKHF_INJECTED)) {
      const bool down = wParam == WM_KEYDOWN || wParam == WM_SYSKEYDOWN;
      const DWORD vk = k->vkCode;
      bool isMod = true;
      if (vk == VK_LCONTROL || vk == VK_RCONTROL || vk == VK_CONTROL) g_ctrl[vk == VK_RCONTROL] = down;
      else if (vk == VK_LWIN || vk == VK_RWIN) g_win[vk == VK_RWIN] = down;
      else isMod = false;
      const bool both = (g_ctrl[0] || g_ctrl[1]) && (g_win[0] || g_win[1]);
      if (!isMod && down && (both || g_active)) {
        if (g_active) emitHotkey("cancel");
        g_active = false;
        g_spoiled = true;
      } else if (isMod) {
        if (both && !g_active && !g_spoiled) {
          g_active = true;
          maskStartMenu();
          emitHotkey("down");
        } else if (!both) {
          if (g_active) emitHotkey("up");
          g_active = false;
          if (!(g_ctrl[0] || g_ctrl[1]) && !(g_win[0] || g_win[1])) g_spoiled = false;
        }
      }
    }
  }
  return CallNextHookEx(nullptr, nCode, wParam, lParam);
}

static int runHotkey() {
  HHOOK hook = SetWindowsHookExW(WH_KEYBOARD_LL, hotkeyHook, GetModuleHandleW(nullptr), 0);
  if (!hook) {
    fprintf(stderr, "SetWindowsHookEx: %lu\n", GetLastError());
    return 1;
  }
  printLine("{\"hotkey\":\"ready\"}");
  MSG msg;
  while (GetMessageW(&msg, nullptr, 0, 0) > 0) {
    TranslateMessage(&msg);
    DispatchMessageW(&msg);
  }
  UnhookWindowsHookEx(hook);
  return 0;
}

static std::wstring argAt(int argc, wchar_t** argv, int i) { return i < argc ? argv[i] : L""; }

int main() {
  int argc = 0;
  wchar_t** argv = CommandLineToArgvW(GetCommandLineW(), &argc);
  if (!argv) return 1;
  const std::wstring cmd = argAt(argc, argv, 1);
  int code = 0;
  if (cmd == L"detect") {
    double interval = 2;
    for (int i = 2; i < argc; i++) {
      if (wcscmp(argv[i], L"--interval") == 0 && i + 1 < argc) interval = wcstod(argv[i + 1], nullptr);
    }
    if (interval < 0.5) interval = 2;
    for (;;) {
      printDetect();
      Sleep((DWORD)(interval * 1000));
    }
  } else if (cmd == L"check") {
    printLine("{\"mic\":\"prompt\",\"screen\":\"not-used\",\"calendar\":\"not-used\"}");
  } else if (cmd == L"devices" || cmd == L"events") {
    printLine("[]");
  } else if (cmd == L"request") {
    printLine("{}");
  } else if (cmd == L"paste") {
    code = sendPaste();
  } else if (cmd == L"hotkey") {
    code = runHotkey();
  } else if (cmd == L"capture") {
    fprintf(stderr, "En Windows el audio lo captura la ventana de Acta, no este programa.\n");
    code = 2;
  } else {
    fprintf(stderr, "uso: acta-audio detect|check|devices|request|events|paste|hotkey\n");
    code = 2;
  }
  LocalFree(argv);
  return code;
}
