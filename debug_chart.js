
const hist = {
    1701414000000: 100, // 07:00
    1701417600000: 101, // 08:00
    1701421200000: 102  // 09:00
};

const sortedTs = Object.keys(hist).map(Number).sort((a, b) => a - b);
console.log("Sorted TS:", sortedTs);

const labels = [];
const labelFn = (dateUTC) => {
    const local = new Date(dateUTC);
    return local.toLocaleTimeString('fr-FR', { hour: '2-digit', minute: '2-digit' });
};

sortedTs.forEach(ts => {
    // Mimic the bug in dataManager.js
    const bugTs = ts * 1000;
    console.log(`TS: ${ts}, BugTS: ${bugTs}, Date: ${new Date(bugTs).toISOString()}`);
    labels.push(labelFn(bugTs));
});

console.log("Labels:", labels);
