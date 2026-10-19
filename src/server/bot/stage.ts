/**
 * Fork — el cerebro externo avanza la tarjeta del lead (`POST /api/bot/stage`).
 *
 * Caso que lo motiva: el agente envió una cotización y el lead debe aparecer en
 * «Cotizado» sin que nadie la arrastre. Lo que el bot NO puede hacer es
 * desordenar el tablero que el dueño cuida a mano, así que el único modo es
 * «solo hacia adelante»:
 *
 *   - nunca saca a un lead de una etapa ganada o perdida;
 *   - nunca lo devuelve a una etapa anterior;
 *   - nunca lo lleva a una etapa ganada o perdida (cerrar un trato es de una
 *     persona: la venta se confirma con el cliente, no con un mensaje).
 *
 * La decisión es una función pura para poder probarla sin base; el movimiento
 * en sí va SIEMPRE por `moveLeadToStage`, la puerta única de `stage_id`.
 */

export type StageForDecision = {
  id: string;
  name: string;
  position: number;
  kind: "open" | "won" | "lost";
};

export type ForwardDecision =
  | { action: "move" }
  | { action: "already" }
  | {
      action: "skipped_not_forward";
      why: "current_closed" | "target_closed" | "not_after_current";
    };

export function decideForwardMove(
  current: StageForDecision | null,
  target: StageForDecision
): ForwardDecision {
  if (current && current.id === target.id) return { action: "already" };
  if (target.kind !== "open") {
    return { action: "skipped_not_forward", why: "target_closed" };
  }
  // Sin etapa actual (no debería pasar: todo lead nace en una) avanzar es
  // seguro, porque el destino es una etapa abierta.
  if (!current) return { action: "move" };
  if (current.kind !== "open") {
    return { action: "skipped_not_forward", why: "current_closed" };
  }
  if (current.position >= target.position) {
    return { action: "skipped_not_forward", why: "not_after_current" };
  }
  return { action: "move" };
}
