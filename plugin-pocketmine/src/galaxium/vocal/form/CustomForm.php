<?php

declare(strict_types=1);

namespace galaxium\vocal\form;

use pocketmine\form\Form;
use pocketmine\form\FormValidationException;
use pocketmine\player\Player;

/** Formulaire avec curseurs / interrupteurs. */
final class CustomForm implements Form {

	/** @var list<array<string, mixed>> */
	private array $elements = [];

	/** @param \Closure(Player, list<mixed>) : void $onSubmit */
	public function __construct(private string $title, private \Closure $onSubmit) {}

	public function label(string $text) : self {
		$this->elements[] = ["type" => "label", "text" => $text];
		return $this;
	}

	public function slider(string $text, int $min, int $max, int $step, int $default) : self {
		$this->elements[] = ["type" => "slider", "text" => $text, "min" => $min, "max" => $max, "step" => $step, "default" => max($min, min($max, $default))];
		return $this;
	}

	public function toggle(string $text, bool $default) : self {
		$this->elements[] = ["type" => "toggle", "text" => $text, "default" => $default];
		return $this;
	}

	/** @param list<string> $options */
	public function dropdown(string $text, array $options, int $default = 0) : self {
		$this->elements[] = ["type" => "dropdown", "text" => $text, "options" => array_values($options), "default" => $default];
		return $this;
	}

	public function jsonSerialize() : array {
		return ["type" => "custom_form", "title" => $this->title, "content" => $this->elements];
	}

	public function handleResponse(Player $player, $data) : void {
		if ($data === null) return; // fermé
		if (!is_array($data)) throw new FormValidationException("Réponse invalide");
		($this->onSubmit)($player, array_values($data));
	}
}
