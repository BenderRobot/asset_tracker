import { describe, expect, it } from 'vitest';
import { LatestRequestController } from '../src/latestRequestController.js';

describe('LatestRequestController', () => {
    it('annule et invalide une requête quand une plus récente démarre', () => {
        const controller = new LatestRequestController();
        const first = controller.begin();
        const second = controller.begin();

        expect(first.signal.aborted).toBe(true);
        expect(first.isCurrent()).toBe(false);
        expect(second.signal.aborted).toBe(false);
        expect(second.isCurrent()).toBe(true);
    });

    it('invalide le résultat en attente à la fermeture du modal', () => {
        const controller = new LatestRequestController();
        const request = controller.begin();

        controller.cancel();

        expect(request.signal.aborted).toBe(true);
        expect(request.isCurrent()).toBe(false);
    });

    it('ne laisse pas la fin d’une ancienne requête effacer le contrôleur actuel', () => {
        const controller = new LatestRequestController();
        const first = controller.begin();
        const second = controller.begin();

        controller.finish(first.sequence);

        expect(second.isCurrent()).toBe(true);
    });
});
