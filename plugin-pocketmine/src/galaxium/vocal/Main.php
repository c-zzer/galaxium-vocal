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

		$ticks = max(2, (int) $this->getConfig()->get("sync_ticks", 4));
		$this->getScheduler()->scheduleRepeatingTask(new ClosureTask(fn() => $this->sync()), $ticks);

		if ((bool) $this->getConfig()->get("actionbar", true)) {
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
			$this->linked = array_fill_keys(array_map("strval", (array) ($data["linked"] ?? [])), true);
			$this->speaking = array_fill_keys(array_map("strval", (array) ($data["speaking"] ?? [])), true);
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
				$this->post("/api/mc/unlink", ["name" => $sender->getName()], HttpTask::KIND_UNLINK, $sender->getName());
				$sender->sendMessage(self::PREFIX . "§7Ton site vocal a été déconnecté.");
				break;
			case "code":
				$sender->sendMessage(self::PREFIX . "§7Génération de ton code…");
				$this->post("/api/mc/code", ["name" => $sender->getName()], HttpTask::KIND_CODE, $sender->getName(), 20);
				break;
			default:
				$sender->sendMessage(self::PREFIX . "§7Utilisation : §d/vocal §7[code|mute|unmute|status|unlink]");
		}
		return true;
	}

	/** @param array<string, mixed> $body */
	private function post(string $path, array $body, int $kind, string $player, int $timeout = 8) : void {
		$this->getServer()->getAsyncPool()->submitTask(new HttpTask(
			$this->siteUrl . $path, $this->key, (string) json_encode($body), $timeout, $kind, $player
		));
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
