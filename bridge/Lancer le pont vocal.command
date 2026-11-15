#!/bin/bash
# Double-clique sur ce fichier pour lancer le pont Discord (macOS)
cd "$(dirname "$0")"
if ! command -v node >/dev/null 2>&1; then
  echo "❌ Node.js n'est pas installé. Installe la version LTS sur https://nodejs.org puis relance."
  open "https://nodejs.org"
  read -p "Appuie sur Entrée pour fermer…"
  exit 1
fi
if [ ! -d node_modules ]; then
  echo "📦 Installation (une seule fois)…"
  npm install --no-fund --no-audit || { read -p "Erreur d'installation. Entrée pour fermer…"; exit 1; }
fi
echo "🚀 Pont vocal Galaxium lancé. Laisse cette fenêtre ouverte (le Mac ne se mettra pas en veille)."
caffeinate -i node bridge.js
read -p "Le pont s'est arrêté. Appuie sur Entrée pour fermer…"
