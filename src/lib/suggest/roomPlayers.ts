"use client";
/**
 * The players in the host's room right now (their anonymous device ids), so fresh-content requests
 * can skip what any of them has already seen with this host. Set by the host screen; read by
 * requestSuggest. Player ids are random per device and carry no name.
 */
let current: string[] = [];

export function setRoomPlayers(ids: string[]): void {
  current = ids.filter((id) => typeof id === "string" && /^[A-Za-z0-9_-]{4,40}$/.test(id) && !id.startsWith("bot-")).slice(0, 50);
}

export function roomPlayers(): string[] {
  return current;
}
