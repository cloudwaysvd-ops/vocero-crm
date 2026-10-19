import { describe, expect, it } from "vitest";
import { resolveStage } from "@/server/ai/actions";
import { decideForwardMove, type StageForDecision } from "@/server/bot/stage";

/**
 * Fork — `POST /api/bot/stage`: el cerebro externo avanza la tarjeta, solo
 * hacia adelante. Lo que se prueba es la regla; el movimiento lo hace la
 * puerta única (`moveLeadToStage`), que tiene su propio guardarraíl.
 */

const nuevo: StageForDecision = { id: "s1", name: "Nuevo", position: 0, kind: "open" };
const calificado: StageForDecision = { id: "s2", name: "Calificado", position: 1, kind: "open" };
const cotizado: StageForDecision = { id: "s3", name: "Cotizado", position: 2, kind: "open" };
const ganado: StageForDecision = { id: "s4", name: "Ganado", position: 3, kind: "won" };
const perdido: StageForDecision = { id: "s5", name: "Perdido", position: 4, kind: "lost" };

describe("decideForwardMove", () => {
  it("de Nuevo a Cotizado → mueve", () => {
    expect(decideForwardMove(nuevo, cotizado)).toEqual({ action: "move" });
  });

  it("ya está en Cotizado → already (repetir no hace nada)", () => {
    expect(decideForwardMove(cotizado, cotizado)).toEqual({ action: "already" });
  });

  it("nunca lo devuelve atrás", () => {
    expect(decideForwardMove(cotizado, calificado)).toEqual({
      action: "skipped_not_forward",
      why: "not_after_current",
    });
  });

  it("nunca lo saca de Ganado ni de Perdido", () => {
    expect(decideForwardMove(ganado, cotizado)).toEqual({
      action: "skipped_not_forward",
      why: "current_closed",
    });
    expect(decideForwardMove(perdido, cotizado)).toEqual({
      action: "skipped_not_forward",
      why: "current_closed",
    });
  });

  it("nunca cierra un trato: Ganado y Perdido no son destinos del bot", () => {
    expect(decideForwardMove(cotizado, ganado)).toEqual({
      action: "skipped_not_forward",
      why: "target_closed",
    });
    expect(decideForwardMove(nuevo, perdido)).toEqual({
      action: "skipped_not_forward",
      why: "target_closed",
    });
  });

  it("una etapa abierta con la misma posición no cuenta como avance", () => {
    const empate = { ...cotizado, id: "s9", name: "Otra" };
    expect(decideForwardMove(cotizado, empate).action).toBe("skipped_not_forward");
  });

  it("lead sin etapa → mueve a una abierta", () => {
    expect(decideForwardMove(null, cotizado)).toEqual({ action: "move" });
  });
});

describe("resolveStage (el nombre que manda el bot)", () => {
  const etapas = [nuevo, cotizado, ganado];

  it("sin distinguir mayúsculas ni espacios de más", () => {
    expect(resolveStage("cotizado", etapas)?.id).toBe("s3");
    expect(resolveStage("  Cotizado ", etapas)?.id).toBe("s3");
  });

  it("una etapa que no existe → null (la ruta responde stage_not_found)", () => {
    expect(resolveStage("Cotizada", etapas)).toBeNull();
  });
});
