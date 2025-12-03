
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
    // Mimic the FIXED code in dataManager.js (no * 1000)
    const fixedTs = ts;
    console.log(`TS: ${ts}, FixedTS: ${fixedTs}, Date: ${new Date(fixedTs).toISOString()}`);
    labels.push(labelFn(fixedTs));
});

console.log("Labels:", labels);
