<?php

declare(strict_types=1);

namespace galaxium\vocal;

use pocketmine\scheduler\AsyncTask;
use pocketmine\Server;

/** Requête HTTP POST faite hors du thread principal (le serveur ne lag pas). */
final class HttpTask extends AsyncTask {

	public const KIND_SYNC = 0;
	public const KIND_CODE = 1;
	public const KIND_UNLINK = 2;

	public function __construct(
		private string $url,
		private string $key,
		private string $body,
		private int $timeout,
		private int $kind,
		private string $player
	) {}

	public function onRun() : void {
		$ch = curl_init($this->url);
		curl_setopt_array($ch, [
			CURLOPT_POST => true,
			CURLOPT_POSTFIELDS => $this->body,
			CURLOPT_RETURNTRANSFER => true,
			CURLOPT_FOLLOWLOCATION => true,
			CURLOPT_CONNECTTIMEOUT => $this->timeout,
			CURLOPT_TIMEOUT => $this->timeout,
			CURLOPT_HTTPHEADER => ["Content-Type: application/json", "x-key: " . $this->key],
		]);
		$res = curl_exec($ch);
		$code = (int) curl_getinfo($ch, CURLINFO_RESPONSE_CODE);
		curl_close($ch);
		$this->setResult([$code, is_string($res) ? $res : null]);
	}

	public function onCompletion() : void {
		$plugin = Server::getInstance()->getPluginManager()->getPlugin("GalaxiumVocal");
		if ($plugin instanceof Main && $plugin->isEnabled()) {
			[$code, $body] = $this->getResult();
			$plugin->onHttpResult($this->kind, $this->player, $code, $body);
		}
	}
}
