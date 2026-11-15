<?php

declare(strict_types=1);

namespace galaxium\vocal\form;

use pocketmine\form\Form;
use pocketmine\player\Player;

/** Menu à boutons (avec image optionnelle). */
final class SimpleForm implements Form {

	/** @var list<array<string, mixed>> */
	private array $buttons = [];
	/** @var list<\Closure(Player) : void> */
	private array $handlers = [];

	public function __construct(private string $title, private string $content = "") {}

	/** @param \Closure(Player) : void $onClick */
	public function button(string $text, ?string $image, \Closure $onClick) : self {
		$b = ["text" => $text];
		if ($image !== null) $b["image"] = ["type" => "path", "data" => $image];
		$this->buttons[] = $b;
		$this->handlers[] = $onClick;
		return $this;
	}

	public function jsonSerialize() : array {
		return ["type" => "form", "title" => $this->title, "content" => $this->content, "buttons" => $this->buttons];
	}

	public function handleResponse(Player $player, $data) : void {
		if (is_int($data) && isset($this->handlers[$data])) ($this->handlers[$data])($player);
	}
}
