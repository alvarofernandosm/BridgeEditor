#!/bin/bash
# Postinst propio: el de electron-builder decide el SUID del chrome-sandbox
# probando `unshare --user` COMO ROOT, a quien AppArmor no restringe, así que
# en Ubuntu 24+ deja 0755 y la app crashea para usuarios normales.
# El SUID 4755 siempre es la opción segura (es lo que hace Google Chrome).

ln -sf '/opt/BridgeEditor/bridge-editor' '/usr/bin/bridge-editor'

chown root:root '/opt/BridgeEditor/chrome-sandbox' || true
chmod 4755 '/opt/BridgeEditor/chrome-sandbox' || true

if hash update-mime-database 2>/dev/null; then
  update-mime-database /usr/share/mime || true
fi

if hash update-desktop-database 2>/dev/null; then
  update-desktop-database /usr/share/applications || true
fi
