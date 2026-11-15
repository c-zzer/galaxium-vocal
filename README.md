# Galaxium Vocal — chat vocal de proximité

Même principe que Bedrock Voice Chat (Alaydriem), mais avec un **site web** à la place d'une appli à installer.

```
Serveur Bedrock (Winheberg)  ──positions 5×/s──►  Site Render  ◄──WebSocket──  navigateurs des joueurs
     behavior pack (server-net)                    (relais + page)        l'audio passe en direct entre joueurs (WebRTC)
```

## 1. Mettre le site en ligne (Render, gratuit)
1. Crée un dépôt GitHub `galaxium-vocal` et mets-y le contenu du dossier `site/` (server.js, package.json, public/…).
2. Sur render.com → **New → Web Service** → choisis le dépôt.
   - Build command : `npm install`
   - Start command : `npm start`
   - Instance : Free
3. Onglet **Environment** → ajoute :
   - `MC_KEY` = un mot de passe long inventé (ex. `gv-8f3k29dk-x7`) — **secret**
   - `VOICE_RANGE` = `24` (distance d'écoute en blocs, optionnel)
4. Déploie. Ton site = `https://galaxium-vocal.onrender.com` (ou le nom donné par Render). Test : `…/health` doit répondre `{"ok":true,...}`.

## 2. Configurer le serveur Winheberg (BDS)
Il faut un serveur **Bedrock Dedicated Server (vanilla)**, pas PocketMine (l'API réseau n'existe que sur BDS).

1. Ouvre `Galaxium_Vocal_BP/scripts/config.js` et remplis :
   - `SITE_URL` = l'adresse Render (sans `/` à la fin)
   - `MC_KEY` = **exactement** la même valeur que sur Render
2. Envoie le dossier `Galaxium_Vocal_BP` dans `behavior_packs/` du serveur (pas dans le dossier du monde : la clé serait visible par les joueurs qui téléchargent le pack).
3. Remplace/crée `config/default/permissions.json` avec le fichier fourni (il autorise `@minecraft/server-net`).
4. Active le pack sur le monde : dans `worlds/<ton monde>/world_behavior_packs.json` ajoute
   `{ "pack_id": "26011b59-d574-414a-8bb0-08308c735577", "version": [1, 0, 0] }`
5. Active les **API bêta** du monde (expérience « Beta APIs »), comme pour ton addon KitMap.
6. Redémarre le serveur.

## 3. En jeu
| Commande | Effet |
|---|---|
| `/vocal` | donne un code à 6 caractères (valable 5 min) |
| `/vocal mute` | coupe / réactive ton micro (bascule) |
| `/vocal unmute` | réactive ton micro |
| `/vocal status` | dit si tu es relié au site |
| `/vocal unlink` | déconnecte ton site |

Le joueur ouvre le site, entre le code, autorise le micro → il entend les joueurs proches avec le son en 3D (gauche/droite selon où il regarde, plus faible avec la distance, rien dans une autre dimension). Le site garde la session 30 jours : plus besoin de code ensuite.

## Bon à savoir
- **Garde la page ouverte** : sur iPhone, si Safari passe en arrière-plan ou l'écran se verrouille, le micro est coupé par iOS. Le mieux : jouer sur PC/console et avoir le site sur le téléphone à côté (avec des écouteurs, sinon écho).
- Render gratuit s'endort sans activité ; le pack l'appelle en continu donc il reste réveillé tant que le serveur MC tourne. Au tout premier démarrage, `/vocal` peut mettre ~30 s.
- Certains réseaux 4G bloquent le pair-à-pair. Si deux joueurs restent sur « Connexion… », ajoute un serveur TURN sur Render : `TURN_URL`, `TURN_USER`, `TURN_PASS` (ex. compte gratuit Metered/ExpressTURN).
- Connexion en maillage : parfait jusqu'à ~10-15 joueurs proches en même temps.
- Options du pack dans `config.js` : actionbar « Vocal connecté », ♪ sous le pseudo de ceux qui parlent (désactivé par défaut pour ne pas casser tes grades).
