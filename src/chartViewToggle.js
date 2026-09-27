// ========================================
// chartViewToggle.js — the ONLY builder of the chart's #view-toggle
// ========================================
// Used at startup by investmentsPage.js / dashboardApp.js (so the switch is
// on screen before the first chart render) and by historicalChart.js's
// _syncViewToggle (portfolio ⇄ single-asset). Stateless: safe to import
// under different ?v= query strings.
//
// Compact icon switch (€ / % or € / unit price) with a sliding thumb — see
// css/chart-toolbar.css. The thumb position is driven by `data-active` on
// the group rather than :has(), so it never drifts from the real state.
// historicalChart.renderChart reads the selected view from
// `.toggle-btn.active[data-view]`.

const VIEW_TOGGLE_OPTIONS = {
    portfolio: [
        { view: 'global', label: '€', title: 'Valeur (€)' },
        { view: 'performance', label: '%', title: 'Performance (%)' }
    ],
    asset: [
        { view: 'global', label: '€', title: 'Valeur de la position (€)' },
        { view: 'unit', icon: 'fa-tag', title: 'Prix unitaire' }
    ]
};

// Second option is the default view in both modes (Performance / Prix unitaire).
export function mountViewToggle(container, mode, onChange) {
    const options = VIEW_TOGGLE_OPTIONS[mode] || VIEW_TOGGLE_OPTIONS.portfolio;
    const defaultView = options[1].view;

    container.dataset.mode = mode;
    container.innerHTML = `<div class="toggle-group view-switch" role="group" aria-label="Mode d'affichage">${options.map(o => `
        <button type="button" class="toggle-btn" data-view="${o.view}" title="${o.title}" aria-label="${o.title}">${o.icon ? `<i class="fa-solid ${o.icon}" aria-hidden="true"></i>` : o.label}</button>`).join('')}
    </div>`;

    const group = container.firstElementChild;
    const buttons = [...group.querySelectorAll('.toggle-btn')];
    const select = (view) => buttons.forEach((btn, i) => {
        const on = btn.dataset.view === view;
        btn.classList.toggle('active', on);
        btn.setAttribute('aria-pressed', String(on));
        if (on) group.dataset.active = String(i);
    });
    select(defaultView);

    // `btn`, never `event.target`: the click may land on the inner icon.
    buttons.forEach(btn => btn.addEventListener('click', () => {
        if (btn.classList.contains('active')) return;
        select(btn.dataset.view);
        onChange?.(btn.dataset.view);
    }));
}
