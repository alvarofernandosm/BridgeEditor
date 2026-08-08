// Cliente del puente que se escribe junto a la skill, para que los agentes
// hablen con BridgeEditor sin depender de la shell.
//
// El motivo es concreto: el guard de Claude Code analiza cada comando de Bash y
// rechaza lo que no puede validar estáticamente. Medido contra el CLI 2.1.226:
//   · `curl -s "$BRIDGE_API/cells" …`  → bloqueado ("Contains simple_expansion")
//   · heredoc con JSON                 → bloqueado ("brace with quote character")
//   · escribir el payload en /tmp      → bloqueado (fuera del directorio de trabajo)
// Es decir: el camino que la skill documentaba sólo era ejecutable en "sin
// preguntar". Con un ejecutable propio, la llamada al puente es un comando
// simple y sin expansiones — validable, y por tanto autorizable con una regla
// quirúrgica en el preset flexible (ver permissions.ts) que abre el puente sin
// abrir `curl` entero, que es el vector de exfiltración que ese preset evita.
//
// De paso, el token deja de viajar en la línea de comandos (donde lo ve
// cualquiera que liste procesos) y el `from` sale de BRIDGE_CELL_ID, así que el
// agente ya no tiene que adivinar su propio id.

import { mkdirSync, writeFileSync } from 'fs'
import { join } from 'path'
import { homedir } from 'os'

const BRIDGE_CLIENT_FILENAME = 'bridge.py'

/** Ruta del cliente, escribiéndolo si hace falta. Va junto a la skill y con
 *  ruta absoluta literal en los ejemplos: un `~` es otra expansión que el guard
 *  de la shell no valida. Vive aquí, sin más dependencias, para que tanto el
 *  puente como el preset de permisos puedan pedirla sin importarse entre sí. */
export function bridgeClientPath(): string {
  const dir = join(homedir(), '.claude', 'skills', 'bridge-cells')
  const file = join(dir, BRIDGE_CLIENT_FILENAME)
  try {
    mkdirSync(dir, { recursive: true })
    writeFileSync(file, BRIDGE_CLIENT, { mode: 0o755 })
  } catch {
    // sin permisos de escritura queda el curl como camino manual
  }
  return file
}

export const BRIDGE_CLIENT = `#!/usr/bin/env python3
"""Cliente del puente de BridgeEditor. Lee BRIDGE_API, BRIDGE_TOKEN y
BRIDGE_CELL_ID del entorno: no hace falta pasarlos por la shell."""
import json, os, sys, urllib.request, urllib.error

API = os.environ.get("BRIDGE_API")
TOKEN = os.environ.get("BRIDGE_TOKEN")
SELF = os.environ.get("BRIDGE_CELL_ID")


def die(msg, code=2):
    print(msg, file=sys.stderr)
    sys.exit(code)


def call(method, path, payload=None, timeout=3600):
    if not API or not TOKEN:
        die("BRIDGE_API/BRIDGE_TOKEN no están en el entorno: ¿esta shell corre dentro de una celda?")
    data = json.dumps(payload).encode() if payload is not None else None
    req = urllib.request.Request(API + path, data=data, method=method)
    req.add_header("Authorization", "Bearer " + TOKEN)
    if data:
        req.add_header("Content-Type", "application/json")
    try:
        with urllib.request.urlopen(req, timeout=timeout) as r:
            return r.status, r.read().decode()
    except urllib.error.HTTPError as e:
        return e.code, e.read().decode()
    except Exception as e:
        die("no se pudo hablar con el puente: %s" % e)


def body_from(args):
    """El texto de la tarea: --text para lo corto, --file para lo largo o lo que
    lleve comillas y llaves (que la shell del agente no deja escribir en línea)."""
    if "--file" in args:
        path = args[args.index("--file") + 1]
        with open(path, encoding="utf-8") as fh:
            return fh.read().strip()
    if "--text" in args:
        return args[args.index("--text") + 1]
    die("falta el mensaje: --text \\"…\\" o --file ruta.txt")


def opt(args, name, default=None):
    return args[args.index(name) + 1] if name in args else default


def main(argv):
    if not argv or argv[0] in ("-h", "--help"):
        print(__doc__ + "\\n\\nComandos: cells | activity | result <celda> | "
              "delegate <celda> (--text T | --file F) [--fresh] [--out ARCHIVO] | "
              "open-cell <agente> [--cwd D] [--model M] [--effort E] (--text T | --file F)")
        return 0
    cmd, args = argv[0], argv[1:]

    if cmd == "cells":
        status, out = call("GET", "/cells", timeout=30)
    elif cmd == "activity":
        status, out = call("GET", "/activity", timeout=30)
    elif cmd == "result":
        if not args:
            die("uso: result <celda>")
        status, out = call("GET", "/result?cell=" + args[0], timeout=30)
    elif cmd == "delegate":
        if not args:
            die("uso: delegate <celda> (--text … | --file …)")
        payload = {"target": args[0], "message": body_from(args)}
        if SELF:
            payload["from"] = SELF
        if "--fresh" in args:
            payload["fresh"] = True
        status, out = call("POST", "/delegate", payload)
    elif cmd == "open-cell":
        if not args:
            die("uso: open-cell <claude|opencode|antigravity> [opciones]")
        payload = {"agent": args[0]}
        for name in ("--cwd", "--model", "--effort"):
            if name in args:
                payload[name[2:]] = opt(args, name)
        if "--text" in args or "--file" in args:
            payload["message"] = body_from(args)
        if SELF:
            payload["from"] = SELF
        status, out = call("POST", "/open-cell", payload)
    else:
        die("comando desconocido: " + cmd)

    # Un turno delegado dura hasta 45 min y la shell del agente corta mucho
    # antes: con --out la respuesta va a un archivo y el turno se recoge después.
    dest = opt(args, "--out")
    if dest:
        with open(dest, "w", encoding="utf-8") as fh:
            fh.write(out)
        print("respuesta guardada en " + dest)
    else:
        print(out)
    return 0 if status < 400 else 1


if __name__ == "__main__":
    sys.exit(main(sys.argv[1:]))
`
