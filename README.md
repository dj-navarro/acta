# Acta — cuaderno de reuniones con IA, en local

Acta escucha tus llamadas (Zoom, Meet, Teams…) sin meter un bot, las transcribe y convierte tus apuntes en notas completas con IA. Funciona en **Mac y Windows**. Todo se queda en tu ordenador: el audio y el texto solo salen hacia el proveedor de IA que tú elijas, con tu propia clave.

## Esta versión: dictado, móvil como micrófono y conexión desde fuera de casa

Esta rama (`jorge/dictado` de [dj-navarro/acta](https://github.com/dj-navarro/acta/tree/jorge/dictado)) añade a Acta:

- **Dictado en cualquier app**, como Wispr Flow: pulsas un atajo, hablas y el texto aparece donde esté el cursor, repasado con IA y adaptado a la app (correo, chat, código…). En Windows, además, **Ctrl + Windows**: mantener para hablar y soltar para pegar.
- **Móvil o tablet como micrófono**: escaneas un QR y grabas desde el teléfono; la transcripción aparece en el ordenador en directo. Se pueden conectar varios a la vez y cada uno sale con su nombre.
- **Conexión desde fuera de casa**: un túnel gratuito de Cloudflare deja conectar el móvil con datos o en otra wifi.

Los instaladores de la sección «Instalar» de más abajo son los de Acta original y **no traen estas funciones**. Para tenerlas hay que compilar el instalador de Windows desde esta rama. Está probado en Windows 10 y 11 de 64 bits; en Mac estas funciones no están probadas.

### 1. Prepara el PC (una sola vez)

| Qué | Dónde | Nota |
|---|---|---|
| Git | [git-scm.com](https://git-scm.com/download/win) | Trae Git Bash, que se usa en los comandos de abajo. |
| Node.js 22 o más nuevo | [nodejs.org](https://nodejs.org) | Probado con Node 24. |
| pnpm | `npm install -g pnpm`, o `winget install pnpm.pnpm` | Probado con pnpm 11. Esta rama se compila con pnpm, no con npm. |
| Visual Studio 2022 Build Tools | [visualstudio.microsoft.com/downloads](https://visualstudio.microsoft.com/es/downloads/) (más abajo, «Herramientas para Visual Studio») | En el instalador marca **Desarrollo para el escritorio con C++**. Compila `acta-audio.exe` (pegar el dictado, Ctrl + Windows y detectar reuniones). |

### 2. Descarga el código e instala las dependencias

En **Git Bash**, dentro de una carpeta con una ruta corta (por ejemplo `C:\Users\<tu-usuario>` o `C:\dev`):

```bash
git clone -b jorge/dictado https://github.com/dj-navarro/acta.git
cd acta
pnpm install
pnpm approve-builds electron esbuild '!electron-winstaller'
```

> **Truco 1 — `pnpm approve-builds`.** Es normal que `pnpm install` termine con un aviso en rojo, `ERR_PNPM_IGNORED_BUILDS`: pnpm no ejecuta por defecto los scripts de instalación de las dependencias. Electron necesita el suyo para descargar su programa y esbuild para su binario. Esa línea los autoriza (y deja fuera `electron-winstaller`, que no hace falta) y vuelve a instalarlos. Si te lo pregunta en modo interactivo, marca solo `electron` y `esbuild`.

### 3. Compila el instalador

Sigue en Git Bash, dentro de la carpeta `acta`:

```bash
npm_config_user_agent="pnpm/11 node/v24 win32 x64" node scripts/package-win.mjs
```

En PowerShell el mismo comando es:

```powershell
$env:npm_config_user_agent = "pnpm/11 node/v24 win32 x64"; node scripts/package-win.mjs
```

Tarda unos minutos. Hace todo seguido: compila la interfaz y el servidor, compila `acta-audio.exe` con Visual Studio, descarga `cloudflared.exe` de la [release oficial de Cloudflare](https://github.com/cloudflare/cloudflared/releases) comprobando su suma SHA-256 (si no coincide, se detiene) y genera el instalador en:

```text
dist\win\Acta-<versión>-x64-Setup.exe
```

> **Truco 2 — ruta corta.** Si el clon está dentro de una carpeta muy profunda, el último paso falla con `makensis.exe process failed` y `!include: could not open file ... StdUtils.nsh`: una ruta interna de `node_modules` supera los 260 caracteres que admite el empaquetador NSIS. Clona en una ruta corta, vuelve a hacer `pnpm install` allí y repite.
>
> **Truco 3 — `npm_config_user_agent`.** electron-builder mira esa variable para saber qué gestor de paquetes se usó. Sin ella cree que es npm, ejecuta `npm list` y falla con `No JSON content found`. Con la variable usa pnpm y funciona.
>
> **Truco 4 — `EPERM: operation not permitted, unlink ... Acta.exe`.** Pasa si sigue abierta una Acta lanzada desde `dist\win\win-unpacked` de una compilación anterior. Ciérrala (también desde el icono de la bandeja, «Salir de Acta») o compila en otra carpeta:
>
> ```bash
> node scripts/build-payload.mjs
> node scripts/build-win-helper.mjs dist/payload/bin/acta-audio.exe
> node scripts/fetch-cloudflared.mjs dist/payload/bin/cloudflared.exe
> npm_config_user_agent="pnpm/11 node/v24 win32 x64" CSC_IDENTITY_AUTO_DISCOVERY=false \
>   node node_modules/electron-builder/cli.js --win nsis --x64 --publish never \
>   --config electron-builder.yml --config.electronVersion=$(node -p "require('electron/package.json').version") \
>   --config.directories.output=dist/win-b
> ```
>
> **Truco 5 — no hay `npx`.** Los scripts de esta rama no lo necesitan: llaman a Vite y a electron-builder directamente con `node`, así que funcionan aunque en el PC solo haya pnpm.

### 4. Instala y configura

1. Abre el `-Setup.exe`. No está firmado, así que Windows mostrará el aviso azul de SmartScreen: **Más información → Ejecutar de todas formas**.
2. **Ajustes → Claves**: pega tu propia clave de [Groq](https://console.groq.com/keys) (tiene plan gratuito). Cada persona usa la suya; nada de esto viene en el repo.
3. **Ajustes → Dictado**: elige el atajo (en Windows, «Ctrl + Windows» es mantener para hablar), el modelo del repaso y si quieres adaptar el estilo a cada app.
4. **Ajustes → Móvil y tablet como micrófono**: actívalo y escanea el QR con la cámara del móvil.
   - Si Windows pregunta por el firewall, permite **Redes privadas**.
   - En la misma wifi, el navegador del móvil avisará de que la conexión «no es privada»: es normal, el certificado lo crea el propio ordenador. **Configuración avanzada → Acceder** (en iPhone, **Mostrar detalles → visitar este sitio web**).
   - **Conectar también desde fuera de casa** abre el túnel de Cloudflare. Con él no sale ese aviso. La dirección cambia cada vez que Acta se reinicia: vuelve a escanear el QR. El código y el enlace vigentes se guardan siempre en `%APPDATA%\Acta\movil-qr.png` y `movil-enlace.txt`.
   - **Modo reserva.** Algunas redes (clínicas, hoteles, empresas) dejan abrir la página pero cortan la conexión en directo (WebSocket), y el móvil se queda en «Conectando…». Desde la versión jorge.9, si esa conexión no se abre, la página pasa sola en unos segundos a enviar el audio con peticiones web normales y lo indica con «(modo reserva)». Añadiendo `?modo=reserva` a la dirección se fuerza ese modo.
   - Si alguien consigue tu enlace, pulsa **Nuevo código**: los dispositivos emparejados tendrán que volver a escanear.

> **Truco 6 — VPN.** Groq bloquea muchas IP de VPN y responde `403 Access denied. Please check your network settings`. Si usas una VPN con túnel dividido (por ejemplo Proton VPN), excluye `Acta.exe` y también `cloudflared.exe` (está en la carpeta de instalación, dentro de `resources\app\bin`). Si con la VPN activa el móvil no conecta en la wifi de casa, activa en la VPN la opción de permitir conexiones de red local.

Los datos de esta instalación quedan en `%APPDATA%\Acta`. La app usa el puerto 47331 en el propio ordenador y 47332 en la red local para el móvil.

### Para modificar el código

```bash
node scripts/build-win-helper.mjs   # bin/acta-audio.exe
node scripts/fetch-cloudflared.mjs  # bin/cloudflared.exe
pnpm dev                            # servidor + interfaz en http://127.0.0.1:4848
pnpm app                            # la app de escritorio contra el código del repo
node node_modules/typescript/bin/tsc --noEmit -p tsconfig.json   # comprobar tipos
```

> **Truco 7 — saltos de línea.** Muchos archivos del repo usan CRLF. Los avisos de Git del tipo `LF will be replaced by CRLF` son normales y no rompen nada.

---

## Instalar

### Opción 1 — Que lo haga Claude (recomendada)

Abre **Claude Code** (en Claude Desktop, la pestaña **Code**) y pega esto:

```text
Instálame Acta en este ordenador. Sigue paso a paso la guía
https://raw.githubusercontent.com/iamasters-academy/acta/main/docs/INSTALAR-CON-CLAUDE.md
Pregúntame lo que necesites y comprueba cada paso antes de seguir.
```

Claude descarga la versión de tu sistema, la instala, la abre y te acompaña con la clave de IA, los permisos y, si quieres, Google Calendar. Tú solo tendrás que pegar tu clave dentro de Acta y aceptar los permisos que pida el sistema.

### Opción 2 — A mano (2 minutos)

1. Descarga la última versión: **[github.com/iamasters-academy/acta/releases/latest](https://github.com/iamasters-academy/acta/releases/latest)**
   - Mac (Apple Silicon e Intel): el archivo `.dmg`.
   - Windows 10/11 de 64 bits: el archivo `-Setup.exe`.
2. Instálala.
   - Mac: abre el `.dmg` y arrastra Acta a Aplicaciones. La primera vez, clic derecho sobre Acta → **Abrir** → **Abrir**.
   - Windows: abre el `.exe`. Si sale el aviso azul de SmartScreen: **Más información** → **Ejecutar de todas formas**.
3. En Acta, **Ajustes → Claves**: pega una clave de [Groq](https://console.groq.com/keys) (tiene plan gratuito) y pulsa **Guardar**.

Ya puedes grabar. El detalle de cada paso está en [INSTALAR.md](INSTALAR.md), y Google Calendar en [docs/GOOGLE.md](docs/GOOGLE.md).

---

*Lo que sigue es para quien quiera modificar Acta o compilarla.*

## Desarrollo

Hace falta Node.js 22 o más reciente. El servidor en desarrollo se ejecuta como TypeScript nativo.

```bash
npm install
npm run dev          # http://127.0.0.1:4848
```

App de escritorio contra el código del repo (usa el Node del sistema y, si existe, `.env.local`):

```bash
npm run build:native # solo macOS, Xcode Command Line Tools
npm run app          # electron .
```

En desarrollo, las claves se leen de `.env.local` subiendo carpetas (la más cercana gana) y no pisan variables que ya estén en el entorno. La app empaquetada no hace eso: cada persona escribe sus claves en Ajustes.

## Instalador de macOS

La app que se distribuye no usa el Node del sistema ni un directorio de trabajo concreto. El servidor va compilado a JavaScript, la interfaz es el build de Vite, el capturador Swift va dentro del bundle y el proceso corre con el Node que trae Electron 38 (`node:sqlite` y FTS5). Los datos (base de datos, audio, exportaciones, `server.log`) se crean en la primera apertura en `~/Library/Application Support/Acta`.

En un Mac (Apple Silicon o Intel, con `xcode-select --install` ya hecho):

```bash
npm install
npm run package:mac
```

Eso genera:

- `dist/Acta-<versión>-universal.dmg`
- `dist/Acta-<versión>-universal.zip`
- `dist/Acta.app`

Solo Apple Silicon, si el slice de Intel da problemas:

```bash
ACTA_ARCH=arm64 npm run package:mac
```

`ACTA_ARCH` también puede ser `x64`. El mínimo del binario Swift es macOS 13.

### Google Calendar

Desde la 0.2.0, cada persona conecta su Google desde la propia app: carga en **Ajustes → Calendario** el archivo `.json` de un cliente OAuth «App de escritorio» que crea en su Google Cloud (gratis, unos 8 minutos, una sola vez). La guía paso a paso está en [docs/GOOGLE.md](docs/GOOGLE.md) y también dentro de la app («Cómo conseguirlo»). Así la build no lleva el cliente de nadie y no hay tope de usuarios.

Con un cliente propio, Acta usa la redirección de bucle local `http://127.0.0.1:<puerto de la app + 1>/` (47332 en la app empaquetada) y solo abre ese puerto mientras dura el inicio de sesión. Los clientes de escritorio no necesitan registrarla.

Opcional: meter un cliente de serie al empaquetar, para que nadie tenga que crear el suyo. `npm run package:mac` no lee `.env.local`; hay que exportarlo:

```bash
export ACTA_GOOGLE_CLIENT_ID="….apps.googleusercontent.com"
export ACTA_GOOGLE_CLIENT_SECRET="…"
# Solo si el cliente ya tiene otra redirección registrada.
# Si no, la app usa http://localhost:47331/api/google/callback.
# export ACTA_GOOGLE_REDIRECT_URI="http://localhost:47331/api/google/callback"
npm run package:mac
```

Ten en cuenta que Google limita a 100 usuarios las apps no verificadas con permisos de calendario, y que el secreto queda dentro de la app (en un programa de escritorio no es secreto de verdad): usa un proyecto de Google Cloud solo para Acta. Si una persona carga su propio cliente en Ajustes, se usa el suyo. La URL iCal y el Calendario del Mac funcionan siempre.

### Firma y notarización (opcionales)

Sin certificado, el script firma en ad-hoc para que macOS pueda recordar los permisos. Quien descargue esa build tiene que abrirla con clic derecho → Abrir, o desde Privacidad y seguridad → Abrir igualmente. El detalle está en [INSTALAR.md](INSTALAR.md).

Con un certificado Developer ID ya instalado en el llavero:

```bash
export ACTA_CODESIGN_IDENTITY="Developer ID Application: Nombre (TEAMID)"
npm run package:mac
```

Para notarizar (hace falta para que se abra con doble clic tras descargarla):

```bash
export ACTA_NOTARIZE=1
export APPLE_ID="tu@correo"
export APPLE_APP_SPECIFIC_PASSWORD="xxxx-xxxx-xxxx-xxxx"
export APPLE_TEAM_ID="TEAMID"
export ACTA_CODESIGN_IDENTITY="Developer ID Application: Nombre (TEAMID)"
npm run package:mac
```

`APPLE_APP_SPECIFIC_PASSWORD` es una contraseña de aplicación de Apple, no la de la cuenta.

El identificador del bundle es `app.acta.meetings`. Se puede cambiar con `ACTA_BUNDLE_ID` antes de empaquetar. Cambiarlo después hace que macOS vuelva a pedir los permisos.

En GitHub Actions, el workflow `.github/workflows/macos-dmg.yml` ejecuta el mismo script. Si existen los secretos `CSC_LINK` (el .p12 en base64) y `CSC_KEY_PASSWORD`, importa el certificado en el runner antes de firmar. La notarización usa `APPLE_ID`, `APPLE_APP_SPECIFIC_PASSWORD` y `APPLE_TEAM_ID`.

## Instalador de Windows

La app de Windows usa el mismo servidor y la misma interfaz. El audio no pasa por el binario Swift: el micrófono lo pide Chromium y el audio de la llamada es el loopback WASAPI que Electron ya trae (`desktopCapturer` + `audio: 'loopback'`). No hay que instalar nada más en el PC de quien usa Acta. Hace falta Windows 10 versión 2004 o más nueva, o Windows 11, en 64 bits.

La detección de reuniones (Zoom, Meet, Teams, Slack, Webex) es un programa pequeño, `acta-audio.exe`, que solo mira títulos de ventana y si el micrófono está en uso. No graba audio.

En un PC con Windows (hace falta Visual Studio con las herramientas de C++ de escritorio):

```bash
npm install
npm run package:win
```

En Linux o en un Mac hace falta el compilador cruzado `x86_64-w64-mingw32-g++` (en Debian/Ubuntu, `g++-mingw-w64-x86-64`). En Linux, además, Wine de 32 bits: electron-builder ejecuta el instalador NSIS, que es un stub de 32 bits, para extraer el desinstalador (`wine` y `wine32:i386`). En un Mac, electron-builder trae su propio Wine. El mismo comando genera el instalador:

```bash
npm install
npm run package:win
```

Salida: `dist/win/Acta-<versión>-x64-Setup.exe`.

Sin compilador de C++ a mano (por ejemplo, en un Mac sin MinGW), se puede reutilizar un `acta-audio.exe` ya compilado de una versión anterior, siempre que `native/win/acta-audio.cpp` no haya cambiado:

```bash
ACTA_WIN_HELPER=/ruta/a/acta-audio.exe npm run package:win
```

Las variables de Google son las mismas que en macOS, y este script tampoco lee `.env.local`. Sin ellas, cada persona carga su propio cliente en Ajustes (ver [docs/GOOGLE.md](docs/GOOGLE.md)). Los datos quedan en `%APPDATA%\Acta`. El puerto de la app empaquetada sigue siendo 47331.

Sin certificado, SmartScreen avisa. El texto para quien instala está en [INSTALAR.md](INSTALAR.md). Para firmar con Authenticode, exporta `CSC_LINK` (el .pfx en base64) y `CSC_KEY_PASSWORD` antes de `npm run package:win`.

El workflow `.github/workflows/windows-setup.yml` hace lo mismo en `windows-latest`.

## Qué hace

| Función | Cómo |
|---|---|
| Sin bot en la llamada | `bin/acta-audio` (Swift) graba el micrófono con AVAudioEngine y el audio del sistema con ScreenCaptureKit. |
| Transcripción | Groq Whisper por defecto, OpenAI, Deepgram o whisper.cpp local. |
| Detecta reuniones | En el Mac, el capturador Swift. En Windows, `acta-audio.exe` (ventanas y micrófono en uso). |
| Calendario | «Conectar con Google» (cada persona carga su cliente de Google en Ajustes, o la build trae uno de serie), URL iCal y, en el Mac, el Calendario del sistema. |
| Notas, plantillas, chat, tareas | En local. La IA solo entra cuando hay una clave en Ajustes. |
| Escritorio | Ventana, icono en la barra de menús, notificaciones, `⌘⇧N`. |

Atajos: `⌘K` buscar · `⌘N` nueva nota · `⌘J` preguntar.

## Piezas

- `server/` — API Express, WebSocket y `node:sqlite` + FTS5. En desarrollo, `node server/index.ts`. En la app, `scripts/build-payload.mjs` lo empaqueta con esbuild a JavaScript.
- `native/main.swift` — capturador, detector, permisos y eventos de calendario. Solo se compila en macOS.
- `native/win/acta-audio.cpp` — detector de reuniones para Windows. El audio lo captura Electron.
- `web/` — React 19, Tailwind 4 y TipTap.
- `electron/` — ventana y barra de menús. En la app empaquetada arranca el servidor con `ELECTRON_RUN_AS_NODE=1`.
- `scripts/package-mac.sh` — DMG y zip universales (arm64 + x64).
- `scripts/package-win.mjs` — instalador NSIS de 64 bits.

## Comprobar sin un Mac

```bash
npm install
npm run typecheck
npm run build:payload
npm run smoke
```

`smoke` arranca el servidor empaquetado, comprueba que ignora `.env.local` y que crea la base de datos en el directorio de datos.

## Límites conocidos

- La cancelación de eco de Apple a veces no arranca (error -10875). Con auriculares no hay eco; si no, Acta compara el texto de los dos canales.
- Los permisos de micrófono, grabación de pantalla y calendario los pide macOS la primera vez. La grabación de pantalla solo se usa para el audio del sistema.
- No hay app de iPhone ni carpetas compartidas: Acta es de una sola persona.
- En Windows el audio del sistema depende del loopback de Chromium. No está probado aquí contra Zoom, Teams ni Meet; el criterio y lo que quedaría por hacer si falla están en [docs/WINDOWS-PLAN.md](docs/WINDOWS-PLAN.md).

## Licencia

PolyForm Shield 1.0.0 ([LICENSE.md](LICENSE.md)). En resumen: puedes usar Acta en tu trabajo, adaptarla y mejorarla; lo que no puedes es ofrecer con ella un producto o servicio que compita con Acta (venderla o revenderla). El texto legal es el que manda.
