# BridgeEditor

IDE agéntico minimalista: una grilla dinámica de hasta 6 terminales (3×2) donde cada
celda corre **Claude Code**, **OpenCode** o un shell libre. Pensado para supervisar
varios agentes trabajando en paralelo sobre repos o worktrees distintos.

## Instalación

**Linux (one-liner):**

```bash
curl -fsSL https://raw.githubusercontent.com/alvarofernandosm/BridgeEditor/main/install.sh | bash
```

**Descargas directas** — en [Releases](https://github.com/alvarofernandosm/BridgeEditor/releases/latest):

| Plataforma | Archivo |
| ---------- | ------------------------------------------ |
| Linux | `bridge-editor_<v>_amd64.deb` · `BridgeEditor-<v>.AppImage` |
| Windows | `BridgeEditor Setup <v>.exe` (instalador) · `BridgeEditor <v>.exe` (portable) |
| macOS | `BridgeEditor-<v>.dmg` (sin firmar: clic derecho → Abrir la primera vez) |

> Requisito en todas las plataformas: tener `claude` y/o `opencode` instalados y
> autenticados para usar los agentes (el shell y el visor funcionan sin nada).

Los releases se generan automáticamente con GitHub Actions al empujar un tag
`v*` (`git tag v0.2.0 && git push --tags`).

## Cómo funciona la grilla

Arranca con 1 celda. Con **+ Nueva celda** la grilla se divide sola:

| Celdas | Layout |
| ------ | ------------------- |
| 1 | pantalla completa |
| 2 | 2 columnas |
| 3 | 3 columnas |
| 4 | 2×2 |
| 5 | 3 arriba + 2 abajo |
| 6 | 3×2 |

Al cerrar una celda la grilla se reacomoda. `Ctrl/Cmd+1…6` salta entre celdas.
**Arrastra el header de una celda y suéltalo sobre otra para intercambiar sus
posiciones** — las terminales siguen corriendo durante el movimiento.
El layout se guarda solo: al reabrir la app, las celdas de archivo se reabren y
las de agente relanzan su comando en el mismo directorio. Para Claude Code,
BridgeEditor detecta el **session id propio de cada celda** (vigilando qué
sesión nueva aparece en `~/.claude/projects/` al lanzarla) y al restaurar usa
`--resume <id>` exacto: cada celda retoma *su* conversación, sin mezclarse
aunque compartan directorio. Si una celda no alcanzó a tener sesión, arranca
limpia. Los chats hacen lo propio con su session id del modo headless. Las
terminales de OpenCode restauran sesión nueva (su TUI tiene selector de
sesiones interno para retomar).

## Supervisión de agentes

- El punto de estado de cada celda indica qué hace el agente: 🟢 trabajando
  (hay salida fluyendo), 🔵 quieto, 🟡 **esperándote**, 🔴 terminado.
- Cuando un agente en una celda no activa se queda en silencio (terminó o pide
  input) o suena la campana de la terminal (Claude Code la usa para pedir
  permisos), la celda se resalta con un **borde ámbar pulsante** hasta que le
  hagas clic.
- **Ctrl+clic sobre una ruta de archivo** en la salida de la terminal la abre
  en una celda visor (rutas absolutas, `~/`, `./` o relativas al directorio de
  la celda; sufijos `:línea:columna` se ignoran).

## Niveles de permisos del agente

El launcher de cada celda tiene un selector de permisos (también el chat):

- **preguntar todo** — el comportamiento normal del agente.
- **flexible** — auto-aprueba lo cotidiano: leer/editar archivos, `git add`,
  `git commit`, `git diff/log/status`, correr tests (`npm run/test`, `make`,
  `cargo`, `go`), comandos de lectura (`ls`, `cat`, `grep`…) y **WebSearch**.
  Sigue preguntando lo crítico: `sudo`, `rm`, `chmod`, `git push`,
  `curl`/`wget`, y **WebFetch** de contenido arbitrario (el vector típico de
  prompt injection). En Claude se aplica con `--settings` (merge con tu
  config); en OpenCode vía `OPENCODE_PERMISSION`.
- **sin preguntar** — `--dangerously-skip-permissions`. Bajo tu
  responsabilidad 😄.

## Insertar rutas externas

Con el foco en una celda (terminal o chat): `Ctrl+Shift+A` abre el selector de
**a**rchivo y `Ctrl+Shift+D` el de **d**irectorio; la ruta elegida se pega
entre comillas en la celda activa. Pensado para referirle al agente archivos
fuera del proyecto sin escribir rutas a mano. Los combos se eligieron para no
chocar con los atajos de Claude Code/OpenCode: las variantes simples
(`Ctrl+O`, `Ctrl+A`, `Ctrl+D`) siguen llegando intactas al TUI.

## Paleta de comandos

`Ctrl+Shift+P` (o `Ctrl+K` fuera de una terminal) abre la paleta: lanzar un
agente en una celda nueva (usa el directorio de la celda activa), abrir un
archivo, cerrar o relanzar la celda activa, o saltar a cualquier celda.
Filtra escribiendo, navega con ↑/↓ y ejecuta con Enter.

## Drag & drop

- Soltar archivos sobre una **terminal** pega sus rutas (entre comillas si hace
  falta) — la forma rápida de adjuntarle un archivo o imagen a Claude Code.
- Soltar un archivo sobre un **launcher** o un **visor** lo abre en esa celda.

## Portapapeles en la terminal

- `Ctrl+Shift+C` / `Ctrl+Shift+V` copian y pegan (`Ctrl+C` sigue siendo SIGINT).
- Seleccionar con el mouse copia al portapapeles primario (Linux) y el clic del
  medio pega desde ahí, como en cualquier terminal.
- Clic derecho abre un menú nativo: Copiar / Pegar / Seleccionar todo / Limpiar.
- En macOS, `Cmd+C` copia si hay selección y `Cmd+V` pega.

Cada celda abre un shell de login real (PTY) en el directorio que elijas y, si
seleccionaste un agente, lanza `claude` u `opencode` dentro. Cuando el agente
termina puedes relanzarlo, cambiar de agente o cerrar la celda.

## Chat agéntico (estilo Antigravity)

Además de la terminal TUI, una celda puede ser un **chat** con Claude Code u
OpenCode (sección "Chat agéntico" del launcher). Es **por celda**: puedes
mezclar chats, terminales y visores en la misma grilla.

- Por debajo corre el modo headless (`claude -p --output-format stream-json`,
  `opencode run`); por encima ves burbujas, **markdown renderizado**, chips de
  herramientas usadas (🔧 Bash, Edit, …), costo y duración de cada turno.
- La conversación continúa entre turnos (`--resume` / `--continue`) e incluso
  **sobrevive reinicios de la app** (la sesión de claude se guarda en el layout).
- Selector de permisos por chat (solo claude): *solo planear*, *acepta
  ediciones* (default) o *sin preguntar*.
- **Selector de modelo por chat**: en OpenCode lista los modelos reales de tu
  instalación (`opencode models`); en Claude, los alias (`fable`, `opus`,
  `sonnet`, `haiku`). Se guarda con el layout y la delegación entre celdas
  respeta el modelo elegido de cada celda.
- `Enter` envía, `Shift+Enter` hace salto de línea, y hay botón Cancelar
  mientras el agente trabaja.
- El **razonamiento** (extended thinking) aparece como bloque colapsable 🧠 y
  cada turno cierra con costo, duración y **tokens**
  (`$0.0123 · 14s · ↑12.3k ↓456 tok`) — en Claude (stream-json) y en OpenCode
  (`--format json`, que además da markdown renderizado, chips de herramientas
  y session id real para el resume exacto por celda).
- **Slash commands del chat**: `/resume` abre un selector visual de sesiones
  anteriores del directorio (botón ↺ también), `/continue` retoma la más
  reciente, `/new` empieza conversación nueva y `/help` muestra la ayuda.
  Cualquier otro `/comando` se envía al agente — los comandos personalizados
  de `.claude/commands/` funcionan; los integrados del TUI (`/compact`, etc.)
  no existen en modo headless.

## Delegación entre celdas (multi-agente)

BridgeEditor levanta un puente HTTP local (solo `127.0.0.1`, con token por
sesión) que permite que el agente de una celda **delegue trabajo a los agentes
de otras celdas** y reciba sus respuestas — p. ej. Claude en la celda 1
orquestando a OpenCode con otros modelos en las celdas 2 y 3.

- Cada agente recibe `BRIDGE_API`, `BRIDGE_TOKEN` y `BRIDGE_CELL_ID` en su
  entorno, y un **skill** (`~/.claude/skills/bridge-cells/`) le enseña a
  Claude a usarlos: `GET /cells` lista las celdas, `POST /delegate` envía una
  tarea y bloquea hasta la respuesta.
- **La primera delegación pide tu permiso** con un diálogo (permitir siempre /
  una vez / denegar), por par origen→destino.
- El turno delegado **se ve en vivo en el chat de la celda destino** con la
  etiqueta 📨 de quién lo envió; la respuesta vuelve al orquestador como JSON.
- Solo las celdas en **modo chat** aceptan delegación (el TUI no tiene salida
  estructurada); las ocupadas devuelven 409.

Pruébalo: abre un chat de Claude en la celda 1 y chats de OpenCode en la 2 y
la 3, y dile a Claude: *"lista las celdas disponibles y delega X a la celda 2
y Y a la 3, luego intégrame los resultados"*.

## Visor de archivos

Una celda también puede abrir un archivo (**📄 Abrir archivo** en el launcher):

- Los `.md` se renderizan con tema oscuro, con **resaltado de sintaxis** en los
  bloques de código, badge del lenguaje y botón **⧉ copiar** (aparece al pasar
  el mouse por el bloque).
- Los archivos de código (TS, JS, Python, Rust, Go, YAML, Dockerfile, etc.) se
  muestran resaltados y con **números de línea**; los formatos no reconocidos,
  como texto plano.
- **Recarga en vivo**: si un agente modifica el archivo, la vista se actualiza
  sola (ideal para ver cómo evoluciona un README mientras Claude lo escribe).
- **✏️ Editar** abre el código fuente; se guarda con `Ctrl+S` o el botón 💾.
- **💬 Comentario** inserta una nota fechada en el cursor
  (`> 💬 **Comentario (2026-06-09):** …`), que se renderiza como cita resaltada.
- Si editas y el archivo cambia en disco a la vez, se avisa con `⚠ cambió en disco`.
- El botón ↩ devuelve la celda al launcher.

## Requisitos

- Node.js 20+
- `claude` y/o `opencode` en el PATH del usuario
- En Linux, herramientas de compilación para `node-pty` (`build-essential`, `python3`)

## Desarrollo

```bash
npm install
npm run dev
```

> **Nota (Ubuntu 24+/Debian con AppArmor estricto):** `npm run dev` detecta solo
> si el sandbox SUID de Chromium no está disponible y lo desactiva para la sesión
> de desarrollo. La alternativa permanente es:
>
> ```bash
> sudo chown root:root node_modules/electron/dist/chrome-sandbox
> sudo chmod 4755 node_modules/electron/dist/chrome-sandbox
> ```
>
> El paquete `.deb` no sufre este problema (el instalador configura el helper);
> el AppImage puede requerir lanzarlo con `--no-sandbox` en esos sistemas.

## Empaquetar

```bash
npm run dist:linux   # AppImage + deb
npm run dist:mac     # dmg (correr en macOS)
npm run dist:win     # instalador NSIS (correr en Windows)
```

## Stack

Electron + electron-vite + React + xterm.js + node-pty.
