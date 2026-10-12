// @vitest-environment jsdom
import { afterEach, expect, it, vi } from 'vitest';

afterEach(() => { vi.unstubAllGlobals(); document.body.replaceChildren(); });

it('shows the version and build returned by the public manifest on page load', async () => {
    document.body.innerHTML = '<aside id="app-sidebar"></aside>';
    const fetchVersion = vi.fn().mockResolvedValue({ ok: true,
        json: () => Promise.resolve({ version: '1.17.2', build: 348 }) });
    vi.stubGlobal('fetch', fetchVersion);
    await import('../src/sidebar-render.js');
    await vi.waitFor(() => expect(document.getElementById('app-version').textContent).toBe('v1.17.2'));
    expect(document.getElementById('app-version').title).toContain('build Git 348');
    expect(fetchVersion).toHaveBeenCalledWith(expect.stringMatching(/^\/version\.json\?t=\d+$/), { cache: 'no-store' });
});
