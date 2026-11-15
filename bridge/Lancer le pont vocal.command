#!/bin/bash
# Galaxium Vocal — pont Discord. Double-clique pour lancer (macOS).
cd "$(dirname "$0")"
clear
echo "🎙  Galaxium Vocal — pont Discord"
echo ""

# ── 1. Node.js (téléchargé dans ce dossier si absent, pas besoin d'installer quoi que ce soit) ──
NODE_VER=v22.12.0
if ! command -v node >/dev/null 2>&1 && [ ! -x ".node/bin/node" ]; then
  ARCH=$(uname -m); [ "$ARCH" = "arm64" ] || ARCH=x64
  echo "📦 Téléchargement de Node.js (une seule fois, ~40 Mo)…"
  mkdir -p .node
  if ! curl -fsSL "https://nodejs.org/dist/$NODE_VER/node-$NODE_VER-darwin-$ARCH.tar.gz" | tar -xz -C .node --strip-components=1; then
    echo "❌ Téléchargement impossible. Vérifie ta connexion puis relance."; read -p "Entrée pour fermer…"; exit 1
  fi
fi
[ -x ".node/bin/node" ] && export PATH="$PWD/.node/bin:$PATH"

# ── 2. Modules (une seule fois) ──
if [ ! -d node_modules ]; then
  echo "📦 Installation des modules (une seule fois)…"
  npm install --no-fund --no-audit --loglevel=error || { echo "❌ Erreur d'installation."; read -p "Entrée pour fermer…"; exit 1; }
fi

# ── 3. Tokens des bots : on ouvre la page de chaque bot, tu colles juste le token ──
touch tokens.txt
have=$(grep -v '^#' tokens.txt | grep -c .)
total=$(grep -c . bots.txt)
if [ "$have" -lt "$total" ]; then
  echo ""
  echo "🔑 Il manque $((total - have)) token(s). Pour chaque bot, une page Discord va s'ouvrir :"
  echo "   clique « Reset Token » → « Yes, do it! » → « Copy », puis colle ici (Cmd+V) et Entrée."
  echo "   (Le token ne s'affiche pas quand tu le colles, c'est normal. Entrée vide = passer.)"
  i=0
  while read -r id; do
    i=$((i+1))
    [ -z "$id" ] && continue
    [ "$i" -le "$have" ] && continue
    open "https://discord.com/developers/applications/$id/bot"
    while true; do
      echo ""
      read -r -s -p "➡️  Token du bot Zgegy Vocal $i : " tok < /dev/tty; echo
      tok=$(printf "%s" "$tok" | tr -d '[:space:]')
      if [ -z "$tok" ]; then echo "   ⏭  Passé"; break; fi
      if [ "$(printf "%s" "$tok" | tr -cd '.' | wc -c | tr -d ' ')" -ne 2 ]; then
        echo "   ⚠️  Ça ne ressemble pas à un token (il doit contenir 2 points). Recommence."; continue
      fi
      echo "$tok" >> tokens.txt
      echo "   ✅ Bot $i enregistré"
      break
    done
  done < bots.txt
  echo ""
fi

# ── 4. Lancement (le Mac ne se met pas en veille tant que cette fenêtre est ouverte) ──
echo "🚀 Pont lancé. Laisse cette fenêtre ouverte. (Ctrl+C pour arrêter)"
echo ""
caffeinate -i node bridge.js
read -p "Le pont s'est arrêté. Entrée pour fermer…"
