<?php

declare(strict_types=1);

namespace galaxium\vocal;

use pocketmine\command\Command;
use pocketmine\command\CommandSender;
use pocketmine\event\Listener;
use pocketmine\event\player\PlayerJoinEvent;
use pocketmine\player\Player;
use pocketmine\plugin\PluginBase;
use pocketmine\scheduler\ClosureTask;
use pocketmine\event\player\PlayerQuitEvent;
use pocketmine\resourcepacks\ZippedResourcePack;
use galaxium\vocal\form\CustomForm;

final class Main extends PluginBase implements Listener {

	public const PREFIX = "§d[Vocal]§r ";

	private string $siteUrl = "";
	private string $key = "";
	private bool $inFlight = false;
	private int $failCount = 0;

	/** @var array<string, true> joueurs reliés au site (nom exact) */
	private array $linked = [];
	/** @var array<string, true> joueurs en train de parler */
	private array $speaking = [];
	/** @var array<string, true> micro coupé en jeu (clé = nom en minuscules) */
	private array $muted = [];
	/** @var array<string, true> micro coupé depuis le site */
	private array $siteMuted = [];
	/** @var array<string, string> dernier état HUD envoyé à chaque joueur */
	private array $hudState = [];
	private bool $hud = true;
	private bool $nametagIcon = true;
	/** @var array<string, true> sourdine en jeu (clé = nom en minuscules) */
	private array $deaf = [];
	/** @var array<string, true> retour micro (s'entendre soi-même, test) — clé = nom en minuscules */
	private array $loop = [];
	/** @var array<string, array<string, int>> volumes réglés avec /voc : écouteur → (cible | "*") → 0-200 */
	private array $prefs = [];

	/** titre invisible (codes couleur uniquement) lu par le resource pack */
	private const HUD_MARK = "§v§c§o";
	private const HUD_CODE = ["off" => "0", "on" => "1", "talk" => "2", "mute" => "3", "deaf" => "4"];
	/** icônes de la police glyph_EA du resource pack */
	private const ICON = ["talk" => "\u{EA00}", "on" => "\u{EA01}", "mute" => "\u{EA02}", "deaf" => "\u{EA03}"];

	protected function onEnable() : void {
		$this->saveDefaultConfig();
		$this->siteUrl = rtrim((string) $this->getConfig()->get("site_url", ""), "/");
		$this->key = (string) $this->getConfig()->get("key", "");
		$mutedFile = $this->getDataFolder() . "muted.json";
		if (is_file($mutedFile)) {
			$data = json_decode((string) file_get_contents($mutedFile), true);
			if (is_array($data)) {
				foreach ($data as $n) $this->muted[strtolower((string) $n)] = true;
			}
		}

		$this->getServer()->getPluginManager()->registerEvents($this, $this);
		$pf = $this->getDataFolder() . "prefs.json";
		if (is_file($pf)) {
			$d = json_decode((string) file_get_contents($pf), true);
			if (is_array($d)) $this->prefs = $d;
		}

		// Resource pack de l'indicateur micro (JSON UI), chargé automatiquement
		$this->hud = (bool) $this->getConfig()->get("hud", true);
		$this->nametagIcon = (bool) $this->getConfig()->get("nametag_icon", true);
		if ($this->hud) {
			try {
				$this->saveResource("GalaxiumVocalRP.zip", true);
				$pack = new ZippedResourcePack($this->getDataFolder() . "GalaxiumVocalRP.zip");
				$manager = $this->getServer()->getResourcePackManager();
				$stack = $manager->getResourceStack();
				array_unshift($stack, $pack); // en haut de la pile
				$manager->setResourceStack($stack);
				$this->getLogger()->info("Resource pack HUD micro chargé");
			} catch (\Throwable $e) {
				$this->getLogger()->warning("Resource pack HUD non chargé : " . $e->getMessage());
			}
		}

		$ticks = max(2, (int) $this->getConfig()->get("sync_ticks", 4));
		$this->getScheduler()->scheduleRepeatingTask(new ClosureTask(fn() => $this->sync()), $ticks);

		if ((bool) $this->getConfig()->get("actionbar", false)) {
			$this->getScheduler()->scheduleRepeatingTask(new ClosureTask(function() : void {
				foreach ($this->getServer()->getOnlinePlayers() as $p) {
					if (!isset($this->linked[$p->getName()])) continue;
					$p->sendActionBarMessage(
						$this->isMuted($p) ? "§c● Micro coupé" : (isset($this->speaking[$p->getName()]) ? "§d● Tu parles" : "§a● Vocal connecté")
					);
				}
			}), 20);
		}
		$this->getLogger()->info("Relié à " . $this->siteUrl);
	}

	protected function onDisable() : void {
		@file_put_contents($this->getDataFolder() . "muted.json", json_encode(array_keys($this->muted)));
		$this->savePrefs();
	}

	private function isMuted(Player $p) : bool {
		return isset($this->muted[strtolower($p->getName())]);
	}

	// ───────────── synchronisation des positions ─────────────
	private function sync() : void {
		if ($this->inFlight) return;
		$list = [];
		foreach ($this->getServer()->getOnlinePlayers() as $p) {
			if (!$p->isOnline()) continue;
			$eye = $p->getEyePos();
			$list[] = [
				"name" => $p->getName(),
				"x" => round($eye->x, 2),
				"y" => round($eye->y, 2),
				"z" => round($eye->z, 2),
				"dim" => $p->getWorld()->getFolderName(),
				"yaw" => (int) round($p->getLocation()->getYaw()),
				"muted" => $this->isMuted($p),
				"deaf" => isset($this->deaf[strtolower($p->getName())]),
				"loop" => isset($this->loop[strtolower($p->getName())]),
			];
		}
		$this->inFlight = true;
		$this->getServer()->getAsyncPool()->submitTask(new HttpTask(
			$this->siteUrl . "/api/mc/sync", $this->key, (string) json_encode(["players" => $list]), 5, HttpTask::KIND_SYNC, ""
		));
	}

	/** appelé par HttpTask::onCompletion */
	public function onHttpResult(int $kind, string $player, int $code, ?string $body) : void {
		$data = $body !== null ? json_decode($body, true) : null;
		$ok = $code === 200 && is_array($data);

		if ($kind === HttpTask::KIND_SYNC) {
			$this->inFlight = false;
			if (!$ok) {
				if ($this->failCount++ % 50 === 0) $this->getLogger()->warning("Site vocal injoignable (HTTP {$code})");
				return;
			}
			$this->failCount = 0;
			$before = $this->linked;
			$this->linked = array_fill_keys(array_map("strval", (array) ($data["linked"] ?? [])), true);
			// joueur qui vient de se relier au site : on lui renvoie ses volumes /voc
			foreach ($this->linked as $n => $_) {
				if (!isset($before[$n]) && !empty($this->prefs[strtolower($n)])) $this->pushPrefs($n);
			}
			$this->speaking = array_fill_keys(array_map("strval", (array) ($data["speaking"] ?? [])), true);
			$this->siteMuted = array_fill_keys(array_map("strval", (array) ($data["muted"] ?? [])), true);
			if ($this->hud || $this->nametagIcon) $this->updateHud();
			return;
		}

		$p = $this->getServer()->getPlayerExact($player);
		if ($p === null) return;
		if ($kind === HttpTask::KIND_CODE) {
			if (!$ok || !isset($data["code"])) {
				$p->sendMessage(self::PREFIX . "§cLe serveur vocal est injoignable. Réessaie dans 30 secondes.");
				return;
			}
			$c = (string) $data["code"];
			$site = (string) preg_replace('#^https?://#', '', $this->siteUrl);
			$p->sendMessage(self::PREFIX . "§fTon code : §l§d{$c}§r\n§7Va sur §b{$site} §7et entre ce code. §8(valable 5 min)");
			$p->sendTitle("§d{$c}", "§7Code vocal — entre-le sur le site", 5, 100, 10);
		}
	}

	// ───────────── /vocal ─────────────
	public function onCommand(CommandSender $sender, Command $command, string $label, array $args) : bool {
		if (!$sender instanceof Player) {
			$sender->sendMessage("Commande réservée aux joueurs.");
			return true;
		}
		if ($command->getName() === "voc") {
			$this->openPanel($sender);
			return true;
		}
		// /vocal sans argument : déjà relié ou micro coupé → même panel que /voc
		if (count($args) === 0 && (isset($this->linked[$sender->getName()]) || $this->isMuted($sender) || isset($this->siteMuted[$sender->getName()]))) {
			$this->openPanel($sender);
			return true;
		}
		$action = strtolower($args[0] ?? "code");
		$k = strtolower($sender->getName());
		switch ($action) {
			case "mute":
				if (isset($this->muted[$k])) unset($this->muted[$k]);
				else $this->muted[$k] = true;
				$sender->sendMessage(self::PREFIX . (isset($this->muted[$k]) ? "§cMicro coupé." : "§aMicro réactivé."));
				break;
			case "unmute":
				unset($this->muted[$k]);
				$sender->sendMessage(self::PREFIX . "§aMicro réactivé.");
				break;
			case "status":
				$sender->sendMessage(self::PREFIX . (isset($this->linked[$sender->getName()]) ? "§aConnecté au site" : "§7Pas connecté au site")
					. (isset($this->muted[$k]) ? " §8· §cmicro coupé" : ""));
				break;
			case "unlink":
				$this->unlinkSite($sender);
				break;
			case "panel":
				$this->openPanel($sender);
				break;
			case "code":
				$this->requestCode($sender);
				break;
			default:
				$sender->sendMessage(self::PREFIX . "§7Utilisation : §d/vocal §7[code|mute|unmute|status|unlink]");
		}
		return true;
	}

	private function requestCode(Player $p) : void {
		$p->sendMessage(self::PREFIX . "§7Génération de ton code…");
		$this->post("/api/mc/code", ["name" => $p->getName()], HttpTask::KIND_CODE, $p->getName(), 20);
	}

	private function unlinkSite(Player $p) : void {
		$this->post("/api/mc/unlink", ["name" => $p->getName()], HttpTask::KIND_UNLINK, $p->getName());
		$p->sendMessage(self::PREFIX . "§7Ton site vocal a été déconnecté.");
	}

	/** @param array<string, mixed> $body */
	private function post(string $path, array $body, int $kind, string $player, int $timeout = 8) : void {
		$this->getServer()->getAsyncPool()->submitTask(new HttpTask(
			$this->siteUrl . $path, $this->key, (string) json_encode($body), $timeout, $kind, $player
		));
	}

	// ───────────── Panel /voc ─────────────
	private const TEX = "textures/ui/galaxium_vocal/";

	private function savePrefs() : void {
		@file_put_contents($this->getDataFolder() . "prefs.json", json_encode($this->prefs));
	}

	private function pushPrefs(string $player) : void {
		$this->post("/api/mc/prefs", ["name" => $player, "prefs" => (object) ($this->prefs[strtolower($player)] ?? [])], HttpTask::KIND_UNLINK, $player);
	}

	private function vol(Player $listener, string $target) : int {
		return (int) ($this->prefs[strtolower($listener->getName())][strtolower($target)] ?? 100);
	}

	private function setVol(Player $listener, string $target, int $v) : void {
		$k = strtolower($listener->getName());
		$this->prefs[$k][strtolower($target)] = max(0, min(200, $v));
		$this->savePrefs();
		$this->pushPrefs($listener->getName());
	}

	/** Ouvre un formulaire 2 ticks plus tard (Bedrock ignore parfois un formulaire envoyé pendant la fermeture du précédent) */
	private function later(Player $p, \Closure $open) : void {
		$this->getScheduler()->scheduleDelayedTask(new ClosureTask(function() use ($p, $open) : void {
			if ($p->isOnline()) $open($p);
		}), 2);
	}

	/** Panel style « Paramètres » de Minecraft : tout sur un seul écran, appliqué dès qu'on valide */
	public function openPanel(Player $p) : void {
		$k = strtolower($p->getName());
		$linked = isset($this->linked[$p->getName()]);
		$muted = isset($this->muted[$k]);
		$deaf = isset($this->deaf[$k]);
		$loop = isset($this->loop[$k]);
		$master = $this->vol($p, "*");

		$names = [];
		foreach ($this->getServer()->getOnlinePlayers() as $o) {
			if ($o === $p) continue;
			$names[] = [$o->getName(), $o->getWorld() === $p->getWorld() ? $o->getPosition()->distance($p->getPosition()) : INF];
		}
		usort($names, fn($a, $b) => $a[1] <=> $b[1]);
		$names = array_slice($names, 0, 40);
		$near = count(array_filter($names, fn($n) => $n[1] <= 24 && isset($this->linked[$n[0]])));
		$options = ["§7Aucun"];
		foreach ($names as [$n, $d]) {
			$v = $this->vol($p, $n);
			$options[] = $n . " §8(" . (is_infinite($d) ? "autre monde" : (int) round($d) . " blocs") . " · " . (!isset($this->linked[$n]) ? "pas sur le vocal" : ($v === 0 ? "§cmuet§8" : $v . "%")) . ")";
		}

		$status = "§l§7GÉNÉRAL§r\n"
			. "§7Site : " . ($linked ? "§aconnecté" : "§cpas connecté") . "   §7À portée : §f" . $near . "\n"
			. ($linked ? "" : "§8Active « Recevoir mon code » puis entre-le sur le site.\n");

		$f = new CustomForm("§l§dVocal de proximité", function(Player $p, array $d) use ($k, $muted, $deaf, $loop, $master, $names, $linked) : void {
			$msgs = [];
			$mic = (bool) ($d[1] ?? !$muted);
			if ($mic === $muted) { // changé
				if ($mic) unset($this->muted[$k]); else $this->muted[$k] = true;
				$msgs[] = $mic ? "§aMicro activé" : "§cMicro coupé";
			}
			$son = (bool) ($d[2] ?? !$deaf);
			if ($son === $deaf) {
				if ($son) unset($this->deaf[$k]); else $this->deaf[$k] = true;
				$msgs[] = $son ? "§aSon activé" : "§cSourdine";
			}
			$lp = (bool) ($d[3] ?? $loop);
			if ($lp !== $loop) {
				if ($lp) $this->loop[$k] = true; else unset($this->loop[$k]);
				$msgs[] = $lp ? "§bRetour micro activé §7(mets un casque)" : "§7Retour micro désactivé";
			}
			$vol = (int) round((float) ($d[4] ?? $master));
			if ($vol !== $master) {
				$this->setVol($p, "*", $vol);
				$msgs[] = "§7Volume général §f" . $vol . "%";
			}
			unset($this->hudState[$p->getName()]); // icône mise à jour tout de suite
			if (count($msgs) > 0) $p->sendMessage(self::PREFIX . implode(" §8· ", $msgs));

			$action = (bool) ($d[6] ?? false);
			if ($action) {
				if ($linked) $this->unlinkSite($p); else $this->requestCode($p);
			}
			$sel = (int) ($d[5] ?? 0);
			if ($sel > 0 && isset($names[$sel - 1])) {
				$target = $names[$sel - 1][0];
				$this->later($p, fn(Player $p) => $this->openPlayerVolume($p, $target));
			}
		});
		$f->label($status)
			->toggle("Micro\n§7Les autres t'entendent", !$muted)
			->toggle("Son\n§7Tu entends les autres", !$deaf)
			->toggle("Retour de mon micro\n§7Tu t'entends toi-même pour tester (casque conseillé)", $loop)
			->slider("Volume général", 0, 200, 5, $master)
			->dropdown("Volume d'un joueur\n§7Choisis un joueur pour régler son volume (rien que pour toi)", $options, 0)
			->toggle($linked ? "§cDéconnecter le site" : "§dRecevoir mon code de connexion", false);
		$p->sendForm($f);
	}

	private function stateOf(Player $o) : string {
		$n = $o->getName();
		if (!isset($this->linked[$n])) return "0";
		if (isset($this->deaf[strtolower($n)])) return "4";
		if ($this->isMuted($o) || isset($this->siteMuted[$n])) return "3";
		return isset($this->speaking[$n]) ? "2" : "1";
	}

	private function openPlayerVolume(Player $p, string $target) : void {
		$v = $this->vol($p, $target);
		$f = new CustomForm("§l§d" . $target, function(Player $p, array $d) use ($target, $v) : void {
			$vol = (int) round((float) ($d[1] ?? $v));
			if (!empty($d[2])) $vol = 0;
			elseif ($vol === 0 && $v === 0) $vol = 100; // décocher "muet" remet à 100 %
			if ($vol !== $v) {
				$this->setVol($p, $target, $vol);
				$p->sendMessage(self::PREFIX . "§7" . $target . " : " . ($vol === 0 ? "§cmuet pour toi" : "§f" . $vol . "%"));
			}
			$this->later($p, fn(Player $p) => $this->openPanel($p));
		});
		$f->label("§7Règle à quel volume tu entends §f" . $target . "§7. Lui ne voit pas ce réglage.")
			->slider("Volume", 0, 200, 5, $v)
			->toggle("Ne plus l'entendre (muet pour moi)", $v === 0);
		$p->sendForm($f);
	}

	/** Envoie l'état du micro au HUD (titre invisible "gvc:...") seulement quand il change */
	private function updateHud() : void {
		foreach ($this->getServer()->getOnlinePlayers() as $p) {
			$n = $p->getName();
			if (!isset($this->linked[$n])) $state = "off";
			elseif (isset($this->deaf[strtolower($n)])) $state = "deaf";
			elseif ($this->isMuted($p) || isset($this->siteMuted[$n])) $state = "mute";
			elseif (isset($this->speaking[$n])) $state = "talk";
			else $state = "on";
			if ($this->hud && ($this->hudState[$n] ?? "off") !== $state) {
				$this->hudState[$n] = $state;
				$p->sendTitle(self::HUD_MARK . self::HUD_CODE[$state]);
			}
			if ($this->nametagIcon) $this->applyNameTagIcon($p, $state);
		}
	}

	/** Icône de son à gauche du pseudo (au-dessus de la tête). Résiste aux plugins qui réécrivent le nametag. */
	private function applyNameTagIcon(Player $p, string $state) : void {
		$tag = $p->getNameTag();
		$clean = (string) preg_replace('/[\x{EA00}-\x{EA03}] ?/u', '', $tag);
		$icon = self::ICON[$state] ?? "";
		if ($icon === "") {
			$want = $clean;
		} else {
			$pos = strpos($clean, $p->getName());
			$want = $pos === false ? $icon . " " . $clean : substr($clean, 0, $pos) . $icon . " " . substr($clean, $pos);
		}
		if ($want !== $tag) $p->setNameTag($want);
	}

	public function onQuit(PlayerQuitEvent $e) : void {
		unset($this->hudState[$e->getPlayer()->getName()], $this->loop[strtolower($e->getPlayer()->getName())]);
	}

	public function onJoin(PlayerJoinEvent $e) : void {
		if (!(bool) $this->getConfig()->get("join_message", true)) return;
		$p = $e->getPlayer();
		$this->getScheduler()->scheduleDelayedTask(new ClosureTask(function() use ($p) : void {
			if ($p->isOnline() && !isset($this->linked[$p->getName()])) {
				$p->sendMessage(self::PREFIX . "§7Le vocal de proximité est dispo ! Tape §d/vocal §7pour te connecter.");
			}
		}), 100);
	}
}
